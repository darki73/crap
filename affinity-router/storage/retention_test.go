package storage

import (
	"context"
	"testing"
	"time"
)

func TestOperationalRetentionPreservesLedgerAndFreshBindings(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	id := eventFixture().EventID
	before := time.Now().Add(-30 * 24 * time.Hour)
	_, err := pool.Exec(ctx, "INSERT INTO affinity_router.affinity_bindings(scope,account_id,expires_at) VALUES($1,'fixture',$3),($2,'fixture',$4)", "old-"+id, "fresh-"+id, before.Add(-time.Hour), before.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	var ledgerBefore int64
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM affinity_router.usage_events").Scan(&ledgerBefore)
	if _, err := PruneOperational(ctx, pool, before, false); err != nil {
		t.Fatal(err)
	}
	var exists bool
	_ = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM affinity_router.affinity_bindings WHERE scope=$1)", "old-"+id).Scan(&exists)
	if !exists {
		t.Fatal("dry run mutated state")
	}
	if _, err := PruneOperational(ctx, pool, before, true); err != nil {
		t.Fatal(err)
	}
	_ = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM affinity_router.affinity_bindings WHERE scope=$1)", "old-"+id).Scan(&exists)
	if exists {
		t.Fatal("old binding retained")
	}
	_ = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM affinity_router.affinity_bindings WHERE scope=$1)", "fresh-"+id).Scan(&exists)
	if !exists {
		t.Fatal("fresh binding deleted")
	}
	var ledgerAfter int64
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM affinity_router.usage_events").Scan(&ledgerAfter)
	if ledgerAfter != ledgerBefore {
		t.Fatal("ledger changed")
	}
}
