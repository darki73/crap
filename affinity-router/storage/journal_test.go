package storage

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestJournalTerminalStateIsImmutable(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	e := JournalEvent{ID: eventFixture().EventID, ReplicaID: "fixture", Model: "fixture", StartedAt: time.Now().UTC().Truncate(time.Microsecond)}
	if err := AppendJournal(ctx, pool, e); err != nil {
		t.Fatal(err)
	}
	admission := e
	e.CompletedAt = e.StartedAt.Add(time.Second)
	e.Outcome = "succeeded"
	for _, v := range []JournalEvent{e, e, admission} {
		if err := AppendJournal(ctx, pool, v); err != nil {
			t.Fatal(err)
		}
	}
	conflict := e
	conflict.Outcome = "failed"
	if err := AppendJournal(ctx, pool, conflict); !errors.Is(err, ErrEventConflict) {
		t.Fatal("completion overwritten", err)
	}
	conflict = e
	conflict.ReplicaID = "another"
	if err := AppendJournal(ctx, pool, conflict); !errors.Is(err, ErrEventConflict) {
		t.Fatal("replica mismatch accepted", err)
	}
	var outcome string
	if err := pool.QueryRow(ctx, "SELECT outcome FROM affinity_router.request_journal WHERE id=$1", e.ID).Scan(&outcome); err != nil || outcome != "succeeded" {
		t.Fatal("journal reopened or changed", err)
	}
	// Completion may arrive first after a restart/replay; later admission is safe.
	e.ID = eventFixture().EventID
	admission.ID = e.ID
	if err := AppendJournal(ctx, pool, e); err != nil {
		t.Fatal(err)
	}
	if err := AppendJournal(ctx, pool, admission); err != nil {
		t.Fatal(err)
	}
}
