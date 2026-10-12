package storage

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	log "github.com/sirupsen/logrus"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Migrate applies the known schema atomically. A transaction-scoped lock serializes
// replicas, and checksums reject edited or unknown migrations before changes.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, errBegin := pool.Begin(ctx)
	if errBegin != nil {
		return fmt.Errorf("begin migration: %w", errBegin)
	}
	defer func() {
		if errRollback := tx.Rollback(context.WithoutCancel(ctx)); errRollback != nil && !errors.Is(errRollback, pgx.ErrTxClosed) {
			log.Error("Failed to roll back affinity migration")
		}
	}()
	if _, errLock := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(702361880194)"); errLock != nil {
		return fmt.Errorf("lock migrations: %w", errLock)
	}
	if _, errSetup := tx.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS affinity_router;
CREATE TABLE IF NOT EXISTS affinity_router.schema_migrations (
name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
)`); errSetup != nil {
		return fmt.Errorf("initialize migrations: %w", errSetup)
	}
	names, errGlob := fs.Glob(migrations, "migrations/*.sql")
	if errGlob != nil {
		return errGlob
	}
	sort.Strings(names)
	checksums := make(map[string]string, len(names))
	for _, name := range names {
		contents, errRead := migrations.ReadFile(name)
		if errRead != nil {
			return errRead
		}
		checksums[name] = fmt.Sprintf("%x", sha256.Sum256(contents))
	}
	rows, errQuery := tx.Query(ctx, "SELECT name, checksum FROM affinity_router.schema_migrations")
	if errQuery != nil {
		return errQuery
	}
	applied := make(map[string]bool)
	for rows.Next() {
		var name, checksum string
		if errScan := rows.Scan(&name, &checksum); errScan != nil {
			rows.Close()
			return errScan
		}
		if expected, exists := checksums[name]; !exists || expected != checksum {
			rows.Close()
			return fmt.Errorf("unknown or modified migration %q", name)
		}
		applied[name] = true
	}
	if errRows := rows.Err(); errRows != nil {
		return errRows
	}
	for _, name := range names {
		if applied[name] {
			continue
		}
		contents, errRead := migrations.ReadFile(name)
		if errRead != nil {
			return errRead
		}
		if _, errApply := tx.Exec(ctx, string(contents)); errApply != nil {
			return fmt.Errorf("apply %s: %w", name, errApply)
		}
		if _, errRecord := tx.Exec(ctx, "INSERT INTO affinity_router.schema_migrations (name, checksum) VALUES ($1, $2)", name, checksums[name]); errRecord != nil {
			return errRecord
		}
	}
	if errCommit := tx.Commit(ctx); errCommit != nil {
		return fmt.Errorf("commit migrations: %w", errCommit)
	}
	return nil
}
