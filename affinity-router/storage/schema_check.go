package storage

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"regexp"

	"github.com/jackc/pgx/v5/pgxpool"
)

// VerifySchema is read-only so runtime processes do not need migration privileges.
func VerifySchema(ctx context.Context, pool *pgxpool.Pool) error {
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	expected := make(map[string]string, len(names))
	for _, name := range names {
		data, err := migrations.ReadFile(name)
		if err != nil {
			return err
		}
		expected[name] = fmt.Sprintf("%x", sha256.Sum256(data))
	}
	rows, err := pool.Query(ctx, "SELECT name, checksum FROM affinity_router.schema_migrations")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name, checksum string
		if err := rows.Scan(&name, &checksum); err != nil {
			return err
		}
		if want, ok := expected[name]; !ok || want != checksum {
			return fmt.Errorf("incompatible schema migration")
		}
		delete(expected, name)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(expected) != 0 {
		return fmt.Errorf("schema migration is required")
	}
	return nil
}

func RestrictMigrationTable(ctx context.Context, pool *pgxpool.Pool, role string) error {
	if !regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`).MatchString(role) {
		return fmt.Errorf("invalid runtime role")
	}
	_, err := pool.Exec(ctx, `REVOKE ALL ON affinity_router.schema_migrations FROM `+role+`; GRANT SELECT ON affinity_router.schema_migrations TO `+role)
	return err
}
