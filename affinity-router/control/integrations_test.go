package control

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"cliproxy-affinity-router/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationPersistenceAndLease(t *testing.T) {
	dsn := os.Getenv("AFFINITY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("dedicated test database required")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.Database != "affinity_test" {
		t.Fatal("dedicated affinity_test database required")
	}
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	lock, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, "SELECT pg_advisory_lock(702361880195)"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, errUnlock := lock.Exec(ctx, "SELECT pg_advisory_unlock(702361880195)"); errUnlock != nil {
			t.Error(errUnlock)
		}
	}()
	if err = storage.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := &Server{Pool: pool}
	original, err := s.integrations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, errRestore := pool.Exec(ctx, "UPDATE affinity_router.integrations SET version=$1,encrypted=$2,lease_owner='',lease_until='-infinity' WHERE singleton", original.Version, original.Encrypted); errRestore != nil {
			t.Error(errRestore)
		}
	}()
	saved, err := s.saveIntegrations(ctx, integrationDocument{Version: original.Version, Encrypted: strings.Repeat("encrypted-fixture", 8)})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != original.Version+1 {
		t.Fatal("revision did not advance")
	}
	if _, err = s.saveIntegrations(ctx, integrationDocument{Version: original.Version, Encrypted: strings.Repeat("stale-fixture", 8)}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("concurrent overwrite was accepted")
	}
	if _, err = pool.Exec(ctx, "UPDATE affinity_router.integrations SET lease_until='-infinity'"); err != nil {
		t.Fatal(err)
	}
	first, err := s.integrationLease(ctx, "worker-one-fixture")
	if err != nil || !first["granted"] {
		t.Fatal("first lease not granted")
	}
	second, err := s.integrationLease(ctx, "worker-two-fixture")
	if err != nil || second["granted"] {
		t.Fatal("competing lease granted")
	}
	if _, err = pool.Exec(ctx, "UPDATE affinity_router.integrations SET lease_until=now()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	second, err = s.integrationLease(ctx, "worker-two-fixture")
	if err != nil || !second["granted"] {
		t.Fatal("expired lease was not transferable")
	}
	if _, err = s.integrationSummary(ctx); err != nil {
		t.Fatal(err)
	}
}
