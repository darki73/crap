// Package plugin implements the supported JSON plugin ABI without importing core
// implementation packages. Only explicitly selected fields leave the hook.
package plugin

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"cliproxy-affinity-router/control"
	"cliproxy-affinity-router/gateway"
	"cliproxy-affinity-router/identity"
	"cliproxy-affinity-router/policy"
	"cliproxy-affinity-router/storage"
)

type Runtime struct {
	Host           func(string, any, any) error
	StrictURL      string
	strictMu       sync.Mutex
	strictDraining bool
	strictActive   sync.WaitGroup
	strictStreams  map[string]func()
	strictTraces   sync.Map

	URL, Token, Replica, Spool string
	Key                        []byte
	Client                     *http.Client
	stop                       chan struct{}
	mu                         sync.Mutex
	spoolMu                    sync.Mutex
	SpoolMaxBytes              int64
	SpoolMaxFiles              int
}
type queued struct {
	Path string
	Body json.RawMessage
}
type Usage struct {
	ResponseHeaders                                                           http.Header
	ExecutorType, AuthType, ServiceTier, ResponseServiceTier                  string
	RequestID, TraceID, Provider, Model, APIKey, SessionID, AuthID, AuthIndex string
	RequestedAt                                                               time.Time
	Latency                                                                   time.Duration
	Failed                                                                    bool
	Detail                                                                    struct{ InputTokens, OutputTokens, ReasoningTokens, CachedTokens, CacheReadTokens, CacheCreationTokens, TotalTokens int64 }
}
type Intercept struct {
	RequestID, TraceID, Model, Outcome string
	Headers                            http.Header
	Body                               []byte
	Metadata                           map[string]any
	StartedAt, CompletedAt             time.Time
}
type Schedule struct {
	Model   string
	Options struct {
		Headers  http.Header
		Metadata map[string]any
	}
	Candidates []struct{ ID, Provider string }
}

func New() (*Runtime, error) {
	// File configuration lets us install alongside an unmodified upstream image.
	values := map[string]string{}
	path := os.Getenv("AFFINITY_PLUGIN_ENV")
	if path == "" {
		path = "/CLIProxyAPI/plugins/affinity.env"
	}
	if contents, err := os.ReadFile(path); err == nil {
		for _, line := range strings.Split(string(contents), "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
			if ok {
				values[k] = v
			}
		}
	}
	get := func(k string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return values[k]
	}
	key, err := hex.DecodeString(get("AFFINITY_ID_KEY"))
	if err != nil || len(key) < 32 {
		return nil, errors.New("identity key missing")
	}
	r := &Runtime{URL: get("AFFINITY_CONTROL_URL"), Token: get("AFFINITY_CONTROL_TOKEN"), Spool: get("AFFINITY_SPOOL"), Key: key, stop: make(chan struct{})}
	if r.Spool == "" {
		r.Spool = "/CLIProxyAPI/plugins/affinity-spool"
	}
	r.Replica, _ = os.Hostname()
	u, err := url.Parse(r.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || len(r.Token) < 32 {
		return nil, errors.New("control service configuration missing")
	}
	r.StrictURL = get("CRAP_STRICT_URL")
	r.Client = &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	if err = os.MkdirAll(r.Spool, 0700); err != nil {
		return nil, err
	}
	if err = r.recoverSpool(); err != nil {
		return nil, err
	}
	go r.worker()
	return r, nil
}
func (r *Runtime) Close() { r.quiesceStrict(); close(r.stop) }
func (r *Runtime) ref(purpose, raw string) string {
	if raw == "" {
		raw = "unknown"
	}
	id, _ := identity.Reference(r.Key, "local", purpose, raw)
	return id
}

var fullTraceID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func (r *Runtime) traceRef(trace string) *string {
	// Current upstream generates this full UUID at ingress. Short legacy log
	// IDs cannot support reliable correlation and remain explicitly unlinked.
	if !fullTraceID.MatchString(trace) {
		return nil
	}
	ref := r.ref("trace", r.Replica+"/"+strings.ToLower(trace))
	return &ref
}
func (r *Runtime) call(path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", r.URL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.Client.Do(req)
	if err != nil {
		return errors.New("control service unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return fmt.Errorf("control service status %d", resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(out)
	}
	_, err = io.Copy(io.Discard, resp.Body)
	return err
}

// enqueue fsyncs sanitized data before acknowledging the host callback. This
// protects events received by the plugin; the host's own pre-hook queue can
// still lose data on a crash. Admission journal entries expose that uncertainty.
func (r *Runtime) enqueue(path string, body any) error {
	r.spoolMu.Lock()
	defer r.spoolMu.Unlock()
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(queued{path, raw})
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(r.Spool, "pending-*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	if _, err = file.Write(payload); err == nil {
		err = file.Sync()
	}
	errClose := file.Close()
	if err == nil {
		err = errClose
	}
	if err != nil {
		_ = os.Remove(name)
		return err
	}
	if err = os.Rename(name, strings.TrimSuffix(name, ".tmp")+".json"); err != nil {
		return err
	}
	return syncDirectory(r.Spool)
}
func (r *Runtime) worker() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-ticker.C:
			r.flush()
		}
	}
}
func (r *Runtime) flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	files, err := os.ReadDir(r.Spool)
	if err != nil {
		return
	}
	pending, rejected := 0, 0
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".rejected") {
			rejected++
		}
		if strings.HasSuffix(f.Name(), ".json") {
			pending++
		}
	}
	if r.spoolHealth() != nil {
		rejected++
	}
	_ = r.call("/heartbeat", map[string]any{"ReplicaID": r.Replica, "Pending": pending, "Rejected": rejected}, nil)
	processed := 0
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		if processed >= 100 {
			break
		}
		processed++
		path := filepath.Join(r.Spool, f.Name())
		raw, errRead := os.ReadFile(path)
		if errRead != nil {
			continue
		}
		var event queued
		if json.Unmarshal(raw, &event) != nil {
			_ = os.Rename(path, path+".rejected")
			continue
		}
		if errSend := r.call(event.Path, event.Body, nil); errSend != nil {
			if strings.Contains(errSend.Error(), "status 409") || strings.Contains(errSend.Error(), "status 422") {
				_ = os.Rename(path, path+".rejected")
			}
			continue
		}
		_ = os.Remove(path)
	}
}

func (r *Runtime) Usage(u Usage) storage.UsageEvent {
	account := u.AuthID
	if account == "" {
		account = u.AuthIndex
	}
	started := u.RequestedAt
	if started.IsZero() {
		started = time.Now().UTC()
	}
	latency := u.Latency
	if latency < 0 {
		latency = 0
	}
	outcome := "succeeded"
	if u.Failed {
		outcome = "failed"
	}
	e := storage.UsageEvent{EventID: u.RequestID, RequestID: r.ref("request", r.Replica+"/"+started.Format("2006-01-02")+"/"+u.TraceID+"/"+u.APIKey), ReplicaID: r.Replica, AccountID: r.ref("account", account), ClientID: r.ref("client", u.APIKey), Provider: u.Provider, Model: u.Model, StartedAt: started, FinishedAt: started.Add(latency), Outcome: outcome, Quality: "missing"}
	e.TraceRef = r.traceRef(u.TraceID)
	if u.TraceID == "" {
		e.RequestID = r.ref("request", u.RequestID)
	}
	if u.SessionID != "" {
		session := r.ref("session", u.APIKey+"/"+u.SessionID)
		e.SessionID = &session
	}
	// The public hook does not expose canonical TokenBreakdown. Do not guess
	// whether provider input/output counts include cache or reasoning tokens.
	if u.Detail.TotalTokens > 0 || u.Detail.InputTokens > 0 || u.Detail.OutputTokens > 0 || u.Detail.CacheReadTokens > 0 || u.Detail.CacheCreationTokens > 0 {
		e.Quality = "unclassified"
		if u.Detail.TotalTokens > 0 {
			v := u.Detail.TotalTokens
			e.ReportedTotal = &v
		}
		if u.Detail.CacheReadTokens > 0 {
			v := u.Detail.CacheReadTokens
			e.CacheRead = &v
		}
		if u.Detail.CacheCreationTokens > 0 {
			v := u.Detail.CacheCreationTokens
			e.CacheWrite = &v
		}
		if u.Detail.ReasoningTokens > 0 {
			v := u.Detail.ReasoningTokens
			e.OutputReasoning = &v
		}
	}
	normalizeKnownUsage(u, &e)
	if u.Provider == "claude" && u.ExecutorType == "ClaudeExecutor" {
		if ref := r.responseRef(u.ResponseHeaders); ref != "" {
			e.ResponseRef = &ref
		}
	}
	return e
}
func (r *Runtime) Handle(method string, raw []byte) (any, error) {
	switch method {
	case "model.route", "executor.identifier", "executor.execute", "executor.execute_stream", "executor.count_tokens", "plugin.quiesce", "plugin.shutdown":
		return r.handleStrict(method, raw)
	case "response.intercept_after", "response.intercept_stream_chunk":
		var response cacheResponse
		if err := json.Unmarshal(raw, &response); err != nil {
			return nil, err
		}
		return map[string]any{}, r.observeCache(response)
	case "usage.handle":
		var u Usage
		if err := json.Unmarshal(raw, &u); err != nil {
			return nil, err
		}
		r.strictQuota(u.AuthID, u.ResponseHeaders)
		return map[string]bool{"ok": true}, r.enqueue("/usage", r.Usage(u))
	case "request.intercept_before", "request.intercept_after":
		var req Intercept
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		if ticket := req.Headers.Get("X-Crap-Execution"); ticket != "" {
			if method == "request.intercept_before" {
				r.strictTraces.Store(ticket, req)
			}
			return map[string]any{}, nil
		}
		if method == "request.intercept_before" {
			if err := r.spoolHealth(); err != nil {
				return map[string]any{"Terminate": true, "StatusCode": 503, "ResponseBody": []byte(`{"error":{"code":"affinity_spool_unavailable","message":"Usage delivery queue needs attention"}}`)}, nil
			}
			e := map[string]any{"ID": req.RequestID, "ReplicaID": r.Replica, "Model": req.Model, "StartedAt": time.Now().UTC(), "TraceRef": r.traceRef(req.TraceID)}
			if err := r.call("/journal", e, nil); err != nil {
				return map[string]any{"Terminate": true, "StatusCode": 503, "ResponseBody": []byte(`{"error":{"message":"Routing ledger unavailable"}}`)}, nil
			}
		}
		return map[string]any{}, nil
	case "request.complete":
		var req Intercept
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		// Completion notifications omit request headers. The outer private-model
		// request is journaled by the executor with its original model instead.
		if req.Headers.Get("X-Crap-Execution") != "" || req.Model == gateway.StrictModel {
			return map[string]any{}, nil
		}
		return map[string]any{}, r.enqueue("/journal", map[string]any{"ID": req.RequestID, "ReplicaID": r.Replica, "Model": req.Model, "StartedAt": req.StartedAt, "CompletedAt": req.CompletedAt, "Outcome": req.Outcome, "TraceRef": r.traceRef(req.TraceID)})
	case "scheduler.pick":
		// Strict execution already selected an account through the authenticated
		// gateway grant and passes auth_id to the host callback. The host invokes
		// scheduler hooks again for that pinned execution; legacy policy must not
		// veto it or choose a second account. The private egress grant remains the
		// enforcement boundary for requests that bypass the strict executor.
		if r.StrictURL != "" {
			return map[string]any{"Handled": false}, nil
		}
		var req Schedule
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		client, _ := req.Options.Metadata["caller_scope"].(string)
		if client == "" {
			client = req.Options.Headers.Get("Authorization")
		}
		if client == "" {
			client = req.Options.Headers.Get("X-Api-Key")
		}
		session := req.Options.Headers.Get("Session_id")
		if session == "" {
			session = req.Options.Headers.Get("X-Session-Id")
		}
		if session == "" {
			session = req.Options.Headers.Get("X-Claude-Code-Session-Id")
		}
		if session == "" {
			session = req.Options.Headers.Get("Session-Id")
		}
		if session == "" {
			session = req.Options.Headers.Get("X-Session-Affinity")
		}
		if session == "" {
			session, _ = req.Options.Metadata["canonical_session_id"].(string)
		}
		if session == "" {
			session, _ = req.Options.Metadata["execution_session_id"].(string)
		}
		// Without a trustworthy client namespace or an explicit session, avoid
		// accidental cross-client binding by giving this pick a fresh identity.
		if client == "" || session == "" {
			session = rand.Text()
		}
		pick := control.Pick{SessionID: r.ref("session", client+"/"+session), Model: req.Model}
		ids := map[string]string{}
		for _, c := range req.Candidates {
			id := r.ref("account", c.ID)
			ids[id] = c.ID
			pick.Candidates = append(pick.Candidates, policy.Candidate{ID: id, Provider: c.Provider})
		}
		var d policy.Decision
		if err := r.call("/pick", pick, &d); err != nil {
			return map[string]any{"Handled": true, "Reject": true, "RejectReason": "Affinity control service unavailable", "RejectCode": "affinity_unavailable"}, nil
		}
		if d.Mode == "shadow" {
			return map[string]any{"Handled": false}, nil
		}
		if id := ids[d.AccountID]; id != "" {
			return map[string]any{"Handled": true, "AuthID": id}, nil
		}
		return map[string]any{"Handled": true, "Reject": true, "RejectReason": d.Reason, "RejectCode": "affinity_no_headroom"}, nil
	default:
		return nil, errors.New("unsupported plugin method")
	}
}

const Version = "0.3.1"

func Registration() any {
	// Plugin source and support live in the CRAP monorepo.
	return map[string]any{"schema_version": 6, "metadata": map[string]any{"Name": "affinity-router", "Version": Version, "Author": "CRAP", "GitHubRepository": "https://github.com/darki73/crap", "ConfigFields": []any{}}, "capabilities": map[string]any{"model_router": true, "executor": true, "executor_model_scope": "static", "executor_input_formats": []string{"claude"}, "executor_output_formats": []string{"claude"}, "scheduler": true, "scheduler_across_priorities": true, "usage_plugin": true, "response_interceptor": true, "response_stream_interceptor": true, "request_interceptor": true, "request_lifecycle_plugin": true}}
}
