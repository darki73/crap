package storage

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("AFFINITY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set AFFINITY_TEST_DATABASE_URL to a dedicated PostgreSQL test database")
	}
	config, errParse := pgxpool.ParseConfig(dsn)
	if errParse != nil {
		t.Fatal("invalid test database configuration")
	}
	if config.ConnConfig.Database != "affinity_test" {
		t.Fatal("integration tests require the dedicated affinity_test database")
	}
	pool, errOpen := pgxpool.NewWithConfig(context.Background(), config)
	if errOpen != nil {
		t.Fatal("cannot open test database")
	}
	t.Cleanup(pool.Close)
	lock, errLock := pool.Acquire(context.Background())
	if errLock != nil {
		t.Fatal(errLock)
	}
	if _, errLock = lock.Exec(context.Background(), "SELECT pg_advisory_lock(702361880195)"); errLock != nil {
		lock.Release()
		t.Fatal(errLock)
	}
	t.Cleanup(func() {
		if _, errUnlock := lock.Exec(context.Background(), "SELECT pg_advisory_unlock(702361880195)"); errUnlock != nil {
			t.Error(errUnlock)
		}
		lock.Release()
	})
	return pool
}

func eventFixture() UsageEvent {
	var id [16]byte
	_, _ = rand.Read(id[:])
	return UsageEvent{
		EventID:   fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]),
		RequestID: "request", ReplicaID: "replica", AccountID: "opaque-account", ClientID: "opaque-client",
		Provider: "fixture", Model: "fixture-model", StartedAt: time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC),
		FinishedAt: time.Date(2026, 10, 5, 0, 0, 1, 0, time.UTC), Outcome: "unknown", Quality: "missing",
	}
}

func TestDatabaseContracts(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	t.Run("concurrent migrations", func(t *testing.T) {
		var group sync.WaitGroup
		for range 6 {
			group.Go(func() {
				if err := Migrate(ctx, pool); err != nil {
					t.Error(err)
				}
			})
		}
		group.Wait()
	})
	t.Run("concurrent identical delivery", func(t *testing.T) {
		event := eventFixture()
		var inserts atomic.Int32
		var group sync.WaitGroup
		for range 12 {
			group.Go(func() {
				inserted, err := AppendUsage(ctx, pool, event)
				if err != nil {
					t.Error(err)
				}
				if inserted {
					inserts.Add(1)
				}
			})
		}
		group.Wait()
		if inserts.Load() != 1 {
			t.Fatalf("inserted %d copies", inserts.Load())
		}
		var unknown bool
		if err := pool.QueryRow(ctx, "SELECT reported_total IS NULL FROM affinity_router.usage_events WHERE event_id=$1", event.EventID).Scan(&unknown); err != nil || !unknown {
			t.Fatalf("missing usage must stay null: %v", err)
		}
		event.Model = "conflicting-model"
		if _, err := AppendUsage(ctx, pool, event); !errors.Is(err, ErrEventConflict) {
			t.Fatalf("expected explicit conflict, got %v", err)
		}
	})
	t.Run("complete categories and retry attempts", func(t *testing.T) {
		event := eventFixture()
		zero, input, output, total := int64(0), int64(10), int64(5), int64(15)
		event.Quality, event.Outcome = "complete", "succeeded"
		event.InputUncached, event.CacheRead, event.CacheWrite = &input, &zero, &zero
		event.OutputNonReasoning, event.OutputReasoning, event.ReportedTotal = &output, &zero, &total
		if inserted, err := AppendUsage(ctx, pool, event); err != nil || !inserted {
			t.Fatalf("valid complete event failed: %v", err)
		}
		event.EventID = eventFixture().EventID
		if inserted, err := AppendUsage(ctx, pool, event); err != nil || !inserted {
			t.Fatalf("distinct retry attempt was lost: %v", err)
		}
		for _, change := range []func(*UsageEvent){
			func(e *UsageEvent) { e.ReportedTotal = &zero },
			func(e *UsageEvent) { e.CacheWrite = nil },
			func(e *UsageEvent) { e.Quality = "missing" },
			func(e *UsageEvent) { negative := int64(-1); e.InputUncached = &negative },
			func(e *UsageEvent) { e.FinishedAt = e.StartedAt.Add(-time.Second) },
		} {
			invalid := event
			invalid.EventID = eventFixture().EventID
			change(&invalid)
			if _, err := AppendUsage(ctx, pool, invalid); err == nil {
				t.Error("accepted invalid accounting event")
			}
		}
	})
	t.Run("migration checksum guard", func(t *testing.T) {
		const name = "migrations/001_usage.sql"
		var checksum string
		if err := pool.QueryRow(ctx, "SELECT checksum FROM affinity_router.schema_migrations WHERE name=$1", name).Scan(&checksum); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := pool.Exec(ctx, "UPDATE affinity_router.schema_migrations SET checksum=$1 WHERE name=$2", checksum, name); err != nil {
				t.Error(err)
			}
		})
		if _, err := pool.Exec(ctx, "UPDATE affinity_router.schema_migrations SET checksum='changed' WHERE name=$1", name); err != nil {
			t.Fatal(err)
		}
		if err := Migrate(ctx, pool); err == nil {
			t.Fatal("accepted edited migration")
		}
	})
	t.Run("decimal estimates preserve OAuth billing distinction", func(t *testing.T) {
		e := eventFixture()
		e.Model = e.EventID
		e.AuthType = "oauth"
		e.Quality = "complete"
		input, read, write, output, reason, total := int64(1000000), int64(100000), int64(10000), int64(200000), int64(100000), int64(1410000)
		e.InputUncached = &input
		e.CacheRead = &read
		e.CacheWrite = &write
		e.OutputNonReasoning = &output
		e.OutputReasoning = &reason
		e.ReportedTotal = &total
		if _, err := AppendUsage(ctx, pool, e); err != nil {
			t.Fatal(err)
		}
		p := Price{Provider: e.Provider, Model: e.Model, EffectiveFrom: e.StartedAt, InputRate: "3", CacheReadRate: "0.3", CacheWriteRate: "3.75", OutputRate: "15", ReasoningRate: "15", Note: "Synthetic test rates, not real prices"}
		if err := AddPrice(ctx, pool, p); err != nil {
			t.Fatal(err)
		}
		if err := EstimateUnpriced(ctx, pool); err != nil {
			t.Fatal(err)
		}
		var amount, kind string
		if err := pool.QueryRow(ctx, "SELECT usd::text,kind FROM affinity_router.cost_estimates WHERE event_id=$1", e.EventID).Scan(&amount, &kind); err != nil {
			t.Fatal(err)
		}
		if amount != "7.567500000000" || kind != "api_equivalent" {
			t.Fatalf("unexpected cost %s %s", amount, kind)
		}
		p.InputRate = "9"
		p.EffectiveFrom = e.StartedAt.Add(-time.Second)
		if err := AddPrice(ctx, pool, p); err != nil {
			t.Fatal(err)
		}
		if err := EstimateUnpriced(ctx, pool); err != nil {
			t.Fatal(err)
		}
		var preserved string
		if err := pool.QueryRow(ctx, "SELECT usd::text FROM affinity_router.cost_estimates WHERE event_id=$1", e.EventID).Scan(&preserved); err != nil || preserved != amount {
			t.Fatal("rewrote recorded cost", err)
		}
	})
	t.Run("cache duration pricing waits for verified observation", func(t *testing.T) {
		e := eventFixture()
		e.Provider = "claude"
		e.Model = e.EventID
		e.Quality = "complete"
		e.AuthType = "oauth"
		input, read, write, output, zero, total := int64(10), int64(20), int64(5), int64(7), int64(0), int64(42)
		e.InputUncached, e.CacheRead, e.CacheWrite = &input, &read, &write
		e.OutputNonReasoning, e.OutputReasoning, e.ReportedTotal = &output, &zero, &total
		ref := "v1:" + e.EventID
		e.ResponseRef = &ref
		if _, err := AppendUsage(ctx, pool, e); err != nil {
			t.Fatal(err)
		}
		p := Price{Provider: e.Provider, Model: e.Model, EffectiveFrom: e.StartedAt, InputRate: "4", CacheReadRate: "0.2", CacheWrite5mRate: "5", CacheWrite1hRate: "8", OutputRate: "20", ReasoningRate: "20", Note: "Synthetic mixed cache fixture"}
		if err := AddPrice(ctx, pool, p); err != nil {
			t.Fatal(err)
		}
		if err := EstimateUnpriced(ctx, pool, e.EventID); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM affinity_router.cost_estimates WHERE event_id=$1", e.EventID).Scan(&n); err != nil || n != 0 {
			t.Fatal("guessed unknown cache duration", err)
		}
		observation := CacheObservation{ResponseRef: ref, CacheWrite: 5, CacheWrite5m: 3, CacheWrite1h: 2}
		for range 2 {
			if err := AppendCacheObservation(ctx, pool, observation); err != nil {
				t.Fatal(err)
			}
		}
		if err := EstimateUnpriced(ctx, pool, e.EventID); err != nil {
			t.Fatal(err)
		}
		var amount, basis string
		if err := pool.QueryRow(ctx, "SELECT usd::text,pricing_basis FROM affinity_router.cost_estimates WHERE event_id=$1", e.EventID).Scan(&amount, &basis); err != nil {
			t.Fatal(err)
		}
		if amount != "0.000215000000" || basis != "observed_duration" {
			t.Fatalf("incorrect mixed pricing: %s %s", amount, basis)
		}
		observation.CacheWrite5m, observation.CacheWrite1h = 4, 1
		if err := AppendCacheObservation(ctx, pool, observation); !errors.Is(err, ErrEventConflict) {
			t.Fatal("accepted conflicting observation", err)
		}
		// An observation arriving before usage must also work, without time/model guessing.
		e.EventID = eventFixture().EventID
		ref = "v1:" + e.EventID
		e.ResponseRef = &ref
		observation.ResponseRef = ref
		if err := AppendCacheObservation(ctx, pool, observation); err != nil {
			t.Fatal(err)
		}
		if _, err := AppendUsage(ctx, pool, e); err != nil {
			t.Fatal(err)
		}
		if err := EstimateUnpriced(ctx, pool, e.EventID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM affinity_router.cost_estimates WHERE event_id=$1", e.EventID).Scan(&n); err != nil || n != 1 {
			t.Fatal("lost early observation", err)
		}
		// Matching ID alone is insufficient when the aggregate count disagrees.
		e.EventID = eventFixture().EventID
		write = 6
		total = 43
		if _, err := AppendUsage(ctx, pool, e); err != nil {
			t.Fatal(err)
		}
		if err := EstimateUnpriced(ctx, pool, e.EventID); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM affinity_router.cost_estimates WHERE event_id=$1", e.EventID).Scan(&n); err != nil || n != 0 {
			t.Fatal("priced mismatched totals", err)
		}
		p.CacheWriteRate = "5"
		p.CacheWrite5mRate = ""
		p.CacheWrite1hRate = ""
		if err := AddPrice(ctx, pool, p); err == nil {
			t.Fatal("accepted ambiguous Claude rate")
		}
	})

}
