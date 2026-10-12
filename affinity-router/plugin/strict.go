package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"cliproxy-affinity-router/gateway"
	"cliproxy-affinity-router/policy"
	"cliproxy-affinity-router/storage"
)

type ExecutionError struct {
	Status        int
	Code, Message string
}

func (e *ExecutionError) Error() string { return e.Message }

func (r *Runtime) strictCall(ctx context.Context, ticket, path string, body, out any) error {
	if r.StrictURL == "" {
		return &ExecutionError{503, "crap_strict_unconfigured", "Strict execution boundary is not configured"}
	}
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(r.StrictURL, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+ticket)
	req.Header.Set("X-Crap-Service", r.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.Client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		var failure struct {
			Error struct {
				Code, Message string
				Reset         int64 `json:"reset_at"`
			}
		}
		_ = json.NewDecoder(resp.Body).Decode(&failure)
		if failure.Error.Message == "" {
			failure.Error.Message = "Execution grant is unavailable"
		}
		if failure.Error.Reset > 0 {
			failure.Error.Message += "; earliest reset: " + time.UnixMilli(failure.Error.Reset).UTC().Format(time.RFC3339)
		}
		return &ExecutionError{resp.StatusCode, failure.Error.Code, failure.Error.Message}
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(out)
	}
	return nil
}

func (r *Runtime) quiesceStrict() {
	r.strictMu.Lock()
	r.strictDraining = true
	stops := make([]func(), 0, len(r.strictStreams))
	for _, stop := range r.strictStreams {
		stops = append(stops, stop)
	}
	r.strictMu.Unlock()
	for _, stop := range stops {
		stop()
	}
	r.strictActive.Wait()
}

// Resume is called only when the host registers/reconfigures this runtime after
// quiescence. Ordinary requests cannot reopen admission.
func (r *Runtime) Resume() {
	r.strictMu.Lock()
	r.strictDraining = false
	r.strictMu.Unlock()
}

func (r *Runtime) handleStrict(method string, raw []byte) (any, error) {
	switch method {
	case "executor.identifier":
		return map[string]any{"Identifier": "crap-claude"}, nil
	case "plugin.quiesce", "plugin.shutdown":
		r.quiesceStrict()
		return map[string]any{}, nil
	case "model.route":
		var req struct{ RequestedModel string }
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		return map[string]any{"Handled": req.RequestedModel == gateway.StrictModel, "TargetKind": "self"}, nil
	}
	var req struct {
		Headers  http.Header
		Callback string `json:"host_callback_id"`
		StreamID string `json:"stream_id"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}
	ticket := req.Headers.Get("X-Crap-Execution")
	if ticket == "" || req.Callback == "" || r.Host == nil {
		return nil, &ExecutionError{503, "crap_admission_required", "An authorized CRAP execution is required"}
	}
	r.strictMu.Lock()
	if r.strictDraining {
		r.strictMu.Unlock()
		return nil, &ExecutionError{503, "crap_draining", "Routing plugin is draining"}
	}
	r.strictActive.Add(1)
	if r.strictStreams == nil {
		r.strictStreams = map[string]func(){}
	}
	r.strictStreams[ticket] = func() { _ = r.strictCall(context.Background(), ticket, "/revoke", nil, nil) }
	r.strictMu.Unlock()
	async := false
	finish := func() {
		r.strictMu.Lock()
		delete(r.strictStreams, ticket)
		r.strictMu.Unlock()
		r.strictActive.Done()
		r.strictTraces.Delete(ticket)
	}
	defer func() {
		if !async {
			finish()
		}
	}()
	if err := r.spoolHealth(); err != nil {
		return nil, &ExecutionError{503, "crap_spool_unavailable", "Usage delivery queue needs attention"}
	}
	var grant gateway.Grant
	if err := r.strictCall(context.Background(), ticket, "/claim", nil, &grant); err != nil {
		return nil, err
	}
	if grant.AccountID == "" || grant.Model == "" {
		return nil, errors.New("invalid grant")
	}
	if method == "executor.count_tokens" {
		if !grant.Count {
			return nil, errors.New("invalid count grant")
		}
		var response struct {
			Status int    `json:"status_code"`
			Body   string `json:"body"`
		}
		if err := r.strictCall(context.Background(), ticket, "/count", nil, &response); err != nil {
			return nil, err
		}
		if response.Status >= 400 {
			return nil, &ExecutionError{response.Status, "crap_token_count_failed", "Provider rejected token counting"}
		}
		return map[string]any{"Payload": []byte(response.Body), "Headers": http.Header{"Content-Type": []string{"application/json"}}}, nil
	}
	journal := storage.JournalEvent{ID: grant.ID, ReplicaID: r.Replica, Model: grant.Model, StartedAt: time.Now().UTC()}
	if value, ok := r.strictTraces.Load(ticket); ok {
		journal.TraceRef = r.traceRef(value.(Intercept).TraceID)
	}
	if err := r.call("/journal", journal, nil); err != nil {
		return nil, &ExecutionError{503, "crap_ledger_unavailable", "Routing ledger is unavailable"}
	}
	complete := func(outcome string) {
		journal.CompletedAt = time.Now().UTC()
		journal.Outcome = outcome
		_ = r.enqueue("/journal", journal)
	}
	streaming := method == "executor.execute_stream"
	if streaming != grant.Stream || grant.Count {
		complete("rejected")
		return nil, errors.New("grant protocol mismatch")
	}
	headers := grant.Headers.Clone()
	headers.Del("Authorization")
	headers.Del("X-Api-Key")
	args := map[string]any{"host_callback_id": req.Callback, "entry_protocol": "claude", "exit_protocol": "claude", "forced_provider": "claude", "model": grant.Model, "auth_id": grant.AccountID, "stream": streaming, "body": grant.Body, "headers": headers, "query": grant.Query, "path": "/v1/messages", "proxy_url": grant.ProxyURL}
	if !streaming {
		var resp struct {
			Status  int         `json:"status_code"`
			Headers http.Header `json:"headers"`
			Body    []byte      `json:"body"`
		}
		if err := r.Host("host.model.execute", args, &resp); err != nil {
			r.strictFailure(ticket, err)
			complete("failed")
			return nil, err
		}
		r.strictQuota(grant.AccountID, resp.Headers)
		_ = r.observeCache(cacheResponse{SourceFormat: "claude", ResponseHeaders: resp.Headers, Body: resp.Body})
		complete("succeeded")
		return map[string]any{"Payload": resp.Body, "Headers": resp.Headers}, nil
	}
	var resp struct {
		Headers  http.Header `json:"headers"`
		StreamID string      `json:"stream_id"`
	}
	if err := r.Host("host.model.execute_stream", args, &resp); err != nil {
		r.strictFailure(ticket, err)
		complete("failed")
		return nil, err
	}
	r.strictQuota(grant.AccountID, resp.Headers)
	async = true
	go func() {
		defer finish()
		outcome := "failed"
		defer func() { complete(outcome) }()
		defer func() { _ = r.Host("host.model.stream_close", map[string]any{"stream_id": resp.StreamID}, nil) }()
		failure := ""
		var terminal claudeTerminal
		defer func() {
			_ = r.Host("host.stream.close", map[string]any{"stream_id": req.StreamID, "error": failure}, nil)
		}()
		for {
			var chunk struct {
				Payload []byte `json:"payload"`
				Done    bool   `json:"done"`
				Error   string `json:"error"`
			}
			if err := r.Host("host.model.stream_read", map[string]any{"stream_id": resp.StreamID}, &chunk); err != nil || chunk.Error != "" {
				failure = "Upstream stream interrupted; no automatic retry was made"
				return
			}
			if len(chunk.Payload) > 0 {
				terminal.observe(chunk.Payload)
				_ = r.observeCache(cacheResponse{SourceFormat: "claude", ResponseHeaders: resp.Headers, Body: chunk.Payload})
				if err := r.Host("host.stream.emit", map[string]any{"stream_id": req.StreamID, "payload": chunk.Payload}, nil); err != nil {
					outcome = "canceled"
					return
				}
			}
			if chunk.Done {
				if !terminal.seen {
					failure = "Upstream stream ended before message_stop; no automatic retry was made"
					return
				}
				outcome = "succeeded"
				return
			}
		}
	}()
	return map[string]any{"headers": resp.Headers}, nil
}

// A closed callback alone is not proof that a streaming response completed.
// Retain only an incomplete SSE line in memory and never spool response content.
type claudeTerminal struct {
	pending []byte
	seen    bool
}

func (t *claudeTerminal) observe(chunk []byte) {
	t.pending = append(t.pending, chunk...)
	for {
		i := bytes.IndexByte(t.pending, '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimSpace(t.pending[:i])
		t.pending = t.pending[i+1:]
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		var event struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(bytes.TrimSpace(line[5:]), &event) == nil && event.Type == "message_stop" {
			t.seen = true
		}
	}
	if len(t.pending) > 64<<10 {
		t.pending = nil
	}
}

func (r *Runtime) strictQuota(account string, h http.Header) {
	var windows []policy.Window
	now := time.Now().UnixMilli()
	for _, scope := range []struct{ Key, Label string }{{"5h", "5-hour window"}, {"7d", "Weekly window"}, {"7d-opus", "Weekly · Opus"}, {"7d-sonnet", "Weekly · Sonnet"}, {"7d-fable", "Weekly · Fable"}} {
		prefix := "anthropic-ratelimit-unified-" + scope.Key
		w := policy.Window{Label: scope.Label, Source: "response", ObservedAt: &now, Status: h.Get(prefix + "-status")}
		if value, err := strconv.ParseFloat(h.Get(prefix+"-utilization"), 64); err == nil && value >= 0 && value <= 1 {
			used := 100 * value
			w.Used = &used
		}
		if value, err := strconv.ParseInt(h.Get(prefix+"-reset"), 10, 64); err == nil && value > 0 {
			ms := value * 1000
			w.ResetAt = &ms
		}
		if w.Used != nil || w.Status == "rejected" {
			windows = append(windows, w)
		}
	}
	if len(windows) > 0 {
		q := map[string]any{"accountId": account, "provider": "claude", "checkedAt": now, "windows": windows, "error": false}
		if r.call("/quotas", q, nil) != nil {
			_ = r.enqueue("/quotas", q)
		}
	}
}

func (r *Runtime) strictFailure(ticket string, err error) {
	var failure *ExecutionError
	if !errors.As(err, &failure) {
		return
	}
	reason := ""
	if failure.Status == 401 {
		reason = "invalid_credentials"
	}
	if (failure.Status == 403 || failure.Status == 404) && strings.Contains(strings.ToLower(failure.Message), "model") {
		reason = "model_unavailable"
	}
	if reason != "" {
		_ = r.strictCall(context.Background(), ticket, "/failure", map[string]string{"reason": reason}, nil)
	}
}
