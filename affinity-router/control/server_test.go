package control

import (
	"bytes"
	"cliproxy-affinity-router/identity"
	"cliproxy-affinity-router/policy"
	"cliproxy-affinity-router/storage"
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestControlIntegration(t *testing.T) {
	dsn := os.Getenv("AFFINITY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("dedicated test database required")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.Database != "affinity_test" {
		t.Fatal("dedicated affinity_test database required")
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal("test pool unavailable")
	}
	defer pool.Close()
	lock, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(context.Background(), "SELECT pg_advisory_lock(702361880195)"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, errUnlock := lock.Exec(context.Background(), "SELECT pg_advisory_unlock(702361880195)"); errUnlock != nil {
			t.Error(errUnlock)
		}
	}()
	if err = storage.Migrate(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	key := []byte(strings.Repeat("s", 32))
	s := &Server{Pool: pool, Token: "secret-test-token", IdentityKey: key}
	handler := s.Handler()
	call := func(method, path string, body any, token string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out
	}
	if out := call("GET", "/state", nil, ""); out.Code != 401 {
		t.Fatal("unauthenticated data exposure")
	}
	stamp := time.Now().UnixNano()
	rawID := strings.Repeat("account", 2) + time.Now().Format(time.RFC3339Nano)
	id, _ := identity.Reference(key, "local", "account", rawID)
	out := call("POST", "/quotas", map[string]any{"accountId": rawID, "provider": "test", "plan": "Test", "checkedAt": time.Now().UnixMilli(), "windows": []any{map[string]any{"label": "Weekly window", "used": 15}}}, s.Token)
	if out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	// Restore the default shadow policy, and retain optimistic version checks.
	var version int64
	if err = pool.QueryRow(context.Background(), "UPDATE affinity_router.routing_policy SET mode='shadow',minimum_remaining=5,version=version+1 WHERE singleton RETURNING version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	pick := Pick{SessionID: time.Unix(0, stamp).String(), Model: "test", Candidates: []policy.Candidate{{ID: id, Provider: "test"}}}
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() {
			resp := call("POST", "/pick", pick, s.Token)
			var d policy.Decision
			if resp.Code != 200 || json.Unmarshal(resp.Body.Bytes(), &d) != nil || d.AccountID != id || d.Mode != "shadow" {
				t.Error("concurrent decision failed", resp.Body.String())
			}
		})
	}
	group.Wait()
	updated := policy.Config{Version: version, Mode: "shadow", MinimumRemaining: 10, FreshnessSeconds: 300, AffinitySeconds: 3600}
	if out = call("PUT", "/policy", updated, s.Token); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	if out = call("PUT", "/policy", updated, s.Token); out.Code != 409 {
		t.Fatal("overwrote a concurrent policy edit")
	}
	if out = call("GET", "/state", nil, s.Token); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	if strings.Contains(out.Body.String(), rawID) {
		t.Fatal("raw account identity leaked")
	}
}
