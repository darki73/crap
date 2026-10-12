package control

import (
	"cliproxy-affinity-router/policy"
	"cliproxy-affinity-router/storage"
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"testing"
	"time"
)

func TestStrictFamiliesPersistAndMoveTogether(t *testing.T) {
	dsn := os.Getenv("AFFINITY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("dedicated database required")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.Database != "affinity_test" {
		t.Fatal("dedicated affinity_test required")
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
	_, err = lock.Exec(ctx, "SELECT pg_advisory_lock(702361880195)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = lock.Exec(ctx, "SELECT pg_advisory_unlock(702361880195)") }()
	if err = storage.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `TRUNCATE affinity_router.strict_sessions,affinity_router.strict_families,affinity_router.strict_account_blocks;UPDATE affinity_router.strict_pool SET account_id=''`)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Pool: pool}
	a, b := 80.0, 40.0
	for _, q := range []struct {
		id   string
		used *float64
	}{{"strict-a", &a}, {"strict-b", &b}} {
		if err = s.saveQuota(ctx, q.id, "claude", "", time.Now().Add(-24*time.Hour), []policy.Window{{Label: "Weekly window", Used: q.used}}, false); err != nil {
			t.Fatal(err)
		}
	}
	candidates := []policy.Candidate{{ID: "strict-a", Provider: "claude"}, {ID: "strict-b", Provider: "claude"}}
	pick := func(session, parent, model, want string) {
		t.Helper()
		d, e := s.strictPick(ctx, StrictPick{SessionID: session, ParentID: parent, Model: model, Candidates: candidates})
		if e != nil || d.AccountID != want {
			t.Fatalf("%s got %+v %v", session, d, e)
		}
	}
	pick("parent", "", "claude-sonnet", "strict-a")
	pick("child", "parent", "claude-opus", "strict-a")
	pick("grandchild", "child", "claude-opus", "strict-a")
	full := 100.0
	if err = s.saveQuota(ctx, "strict-a", "claude", "", time.Now(), []policy.Window{{Label: "Weekly window", Used: &full}}, false); err != nil {
		t.Fatal(err)
	}
	pick("grandchild", "child", "claude-opus", "strict-b")
	pick("parent", "", "claude-sonnet", "strict-b")
	s = &Server{Pool: pool}
	zero := 0.0
	if err = s.saveQuota(ctx, "strict-a", "claude", "", time.Now().Add(time.Second), []policy.Window{{Label: "Weekly window", Used: &zero}}, false); err != nil {
		t.Fatal(err)
	}
	pick("parent", "", "claude-sonnet", "strict-b")
	pick("new", "", "claude-sonnet", "strict-b")
	// The first resumed legacy assignment also seeds an empty filling pool.
	_, err = pool.Exec(ctx, `UPDATE affinity_router.strict_pool SET account_id='';INSERT INTO affinity_router.routing_decisions(mode,policy_version,session_id,model,account_id,reason,candidate_count) VALUES('live',1,'strict-legacy','claude-sonnet','strict-a','fixture',2)`)
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.strictPick(ctx, StrictPick{SessionID: "resumed", Model: "claude-sonnet", LegacySessions: []string{"strict-legacy"}, Candidates: candidates})
	if err != nil || d.AccountID != "strict-a" {
		t.Fatalf("legacy assignment lost: %+v %v", d, err)
	}
	pick("new-after-resume", "", "claude-sonnet", "strict-a")
}
