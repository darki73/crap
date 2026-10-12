package plugin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOnlyFullTraceUUIDsAreCorrelated(t *testing.T) {
	r := &Runtime{Replica: "fixture", Key: []byte(strings.Repeat("k", 32))}
	u := Usage{RequestID: "different-attempt-id", TraceID: "00000000-0000-4000-8000-000000000001"}
	got := r.Usage(u).TraceRef
	if got == nil || *got != *r.traceRef(u.TraceID) || strings.Contains(*got, u.TraceID) {
		t.Fatal("trace reference lost or leaked")
	}
	u.TraceID = "12345678"
	if r.Usage(u).TraceRef != nil {
		t.Fatal("legacy short trace was guessed")
	}
}

func TestDurableSanitizedDelivery(t *testing.T) {
	status := http.StatusServiceUnavailable
	var delivered []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing authentication")
		}
		if req.URL.Path == "/heartbeat" {
			w.WriteHeader(200)
			return
		}
		var raw json.RawMessage
		if err := json.NewDecoder(req.Body).Decode(&raw); err != nil {
			t.Error(err)
		}
		delivered = append([]byte(nil), raw...)
		w.WriteHeader(status)
	}))
	defer server.Close()
	r := &Runtime{URL: server.URL, Token: "test-token", Replica: "test-replica", Spool: t.TempDir(), Key: []byte(strings.Repeat("k", 32)), Client: server.Client()}
	u := Usage{RequestID: "00000000-0000-4000-8000-000000000001", TraceID: "12345678", AuthID: "claude-private@example.com.json", APIKey: "secret-api-key", SessionID: "private-session", Provider: "claude", Model: "test", RequestedAt: time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)}
	u.Detail.TotalTokens = 25
	u.Detail.CacheReadTokens = 10
	e := r.Usage(u)
	if e.Quality != "unclassified" || e.InputUncached != nil || e.OutputNonReasoning != nil {
		t.Fatal("guessed canonical accounting")
	}
	if err := r.enqueue("/usage", e); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(r.Spool, "*.json"))
	if len(files) != 1 {
		t.Fatal("event was not durable")
	}
	raw, _ := os.ReadFile(files[0])
	for _, secret := range []string{u.AuthID, u.APIKey, u.SessionID} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("secret persisted in spool")
		}
	}
	r.flush()
	if _, err := os.Stat(files[0]); err != nil {
		t.Fatal("lost event after transient failure")
	}
	// A new runtime can replay files written before a restart.
	restarted := &Runtime{URL: r.URL, Token: r.Token, Replica: r.Replica, Spool: r.Spool, Key: r.Key, Client: r.Client}
	status = http.StatusOK
	restarted.flush()
	if _, err := os.Stat(files[0]); !os.IsNotExist(err) {
		t.Fatal("acknowledged event not removed")
	}
	var received map[string]any
	if err := json.Unmarshal(delivered, &received); err != nil {
		t.Fatal(err)
	}
	if received["EventID"] != u.RequestID {
		t.Fatal("delivery changed event ID")
	}
	if err := r.enqueue("/usage", e); err != nil {
		t.Fatal(err)
	}
	status = http.StatusConflict
	r.flush()
	rejected, _ := filepath.Glob(filepath.Join(r.Spool, "*.rejected"))
	if len(rejected) != 1 {
		t.Fatal("conflicting event must be retained for inspection")
	}
}

func TestSchedulerUsesOurControlDecision(t *testing.T) {
	mode := "shadow"
	var session string
	var selected string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			SessionID  string
			Candidates []struct{ ID string }
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		session = req.SessionID
		selected = req.Candidates[0].ID
		_ = json.NewEncoder(w).Encode(map[string]string{"mode": mode, "accountId": selected, "reason": "affinity retained"})
	}))
	defer server.Close()
	r := &Runtime{URL: server.URL, Token: "test", Key: []byte(strings.Repeat("k", 32)), Client: server.Client()}
	req := `{"Model":"test","Options":{"Metadata":{"caller_scope":"client-a","canonical_session_id":"session-a"}},"Candidates":[{"ID":"private@example.com","Provider":"claude"}]}`
	result, err := r.Handle("scheduler.pick", []byte(req))
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["Handled"] != false {
		t.Fatal("shadow mode changed routing")
	}
	first := session
	mode = "live"
	result, err = r.Handle("scheduler.pick", []byte(req))
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["AuthID"] != "private@example.com" || session != first {
		t.Fatal("live mode did not resolve selected account or stable session")
	}
	_, err = r.Handle("scheduler.pick", []byte(strings.Replace(req, "client-a", "client-b", 1)))
	if err != nil || session == first {
		t.Fatal("session crossed client boundary")
	}
}

func TestStrictExecutionDoesNotRunLegacyScheduler(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"mode":"live","reason":"no candidate has fresh quota and sufficient headroom"}`))
	}))
	defer server.Close()
	r := &Runtime{StrictURL: "http://strict-gateway.invalid", URL: server.URL, Client: server.Client(), Key: []byte(strings.Repeat("k", 32))}
	raw := []byte(`{"Model":"claude-opus-5-5","Candidates":[{"ID":"already-selected","Provider":"claude"}]}`)
	out, err := r.Handle("scheduler.pick", raw)
	if err != nil {
		t.Fatal(err)
	}
	result := out.(map[string]any)
	if result["Handled"] != false || calls != 0 {
		t.Fatalf("strict execution re-entered legacy selection: %#v, calls=%d", result, calls)
	}
	// Outside strict deployments, the existing legacy policy must still apply.
	r.StrictURL = ""
	out, err = r.Handle("scheduler.pick", raw)
	if err != nil {
		t.Fatal(err)
	}
	result = out.(map[string]any)
	if result["RejectCode"] != "affinity_no_headroom" || calls != 1 {
		t.Fatalf("legacy selection changed: %#v, calls=%d", result, calls)
	}
}
