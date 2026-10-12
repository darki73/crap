package storage

import (
	"context"
	"testing"
	"time"
)

func TestCoverageCorrelatesExactTracesWithoutMultiplyingRetries(t *testing.T) {
	p := testPool(t)
	ctx := context.Background()
	if err := Migrate(ctx, p); err != nil {
		t.Fatal(err)
	}
	before := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	base, err := Reconcile(ctx, p, before)
	if err != nil {
		t.Fatal(err)
	}
	e := eventFixture()
	trace := e.EventID
	e.TraceRef = &trace
	j := JournalEvent{ID: e.EventID, ReplicaID: e.ReplicaID, TraceRef: &trace, StartedAt: before.Add(-time.Minute), CompletedAt: before.Add(-time.Second), Outcome: "succeeded"}
	if err := AppendJournal(ctx, p, j); err != nil {
		t.Fatal(err)
	}
	missing, err := Reconcile(ctx, p, before)
	if err != nil || missing.CompletedWithoutUsage != base.CompletedWithoutUsage+1 {
		t.Fatal("missing observation hidden", err, missing)
	}
	for range 2 {
		e.EventID = eventFixture().EventID
		if _, err := AppendUsage(ctx, p, e); err != nil {
			t.Fatal(err)
		}
	}
	after, err := Reconcile(ctx, p, before)
	if err != nil || after.MatchedTraces != base.MatchedTraces+1 || after.CompletedWithoutUsage != base.CompletedWithoutUsage {
		t.Fatal("retry observations multiplied trace or remained missing", err, after)
	}
	j.ID = eventFixture().EventID
	j.TraceRef = nil
	if err := AppendJournal(ctx, p, j); err != nil {
		t.Fatal(err)
	}
	legacy, err := Reconcile(ctx, p, before)
	if err != nil || legacy.UnlinkedJournal != base.UnlinkedJournal+1 {
		t.Fatal("legacy entry guessed", err)
	}
}

func TestRuntimeSchemaCheckRejectsNewerMigrations(t *testing.T) {
	p := testPool(t)
	ctx := context.Background()
	if err := Migrate(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := VerifySchema(ctx, p); err != nil {
		t.Fatal(err)
	}
	// Use a transaction-local search-independent fixture row and always restore it.
	_, err := p.Exec(ctx, "INSERT INTO affinity_router.schema_migrations(name,checksum) VALUES('future-fixture','unknown')")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = p.Exec(ctx, "DELETE FROM affinity_router.schema_migrations WHERE name='future-fixture'")
	}()
	if VerifySchema(ctx, p) == nil {
		t.Fatal("older runtime accepted newer schema")
	}
}
