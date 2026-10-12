package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"time"

	"cliproxy-affinity-router/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		// Connection errors may contain a DSN. Do not echo credentials to logs.
		fmt.Fprintln(os.Stderr, "Database migration failed. Check connection settings and schema compatibility; error details suppressed to protect credentials.")
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	dsn := os.Getenv("AFFINITY_DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("AFFINITY_DATABASE_URL is required")
	}
	pool, errOpen := pgxpool.New(ctx, dsn)
	if errOpen != nil {
		return errOpen
	}
	defer pool.Close()
	if len(os.Args) > 1 {
		if os.Args[1] != "prune" || len(os.Args) > 3 || (len(os.Args) == 3 && os.Args[2] != "--apply") {
			return fmt.Errorf("use prune [--apply]")
		}
		apply := len(os.Args) == 3
		result, err := storage.PruneOperational(ctx, pool, time.Now().Add(-30*24*time.Hour), apply)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"applied": apply, "olderThanDays": 30, "rows": result})
	}
	if errMigrate := storage.Migrate(ctx, pool); errMigrate != nil {
		return errMigrate
	}
	if role := os.Getenv("AFFINITY_RUNTIME_ROLE"); role != "" {
		if err := storage.RestrictMigrationTable(ctx, pool, role); err != nil {
			return err
		}
	}
	if id := os.Getenv("AFFINITY_IMPORT_ID"); id != "" {
		if err := storage.PrepareImport(ctx, pool, id); err != nil {
			return err
		}
	}
	fmt.Println("Affinity database migrations applied successfully.")
	return nil
}
