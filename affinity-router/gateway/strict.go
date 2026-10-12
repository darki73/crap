package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"cliproxy-affinity-router/control"
	"cliproxy-affinity-router/identity"
	"cliproxy-affinity-router/policy"
)

const StrictModel = "crap-internal-claude"

type Grant struct {
	Revision          string      `json:"revision"`
	ID                string      `json:"id"`
	Body              []byte      `json:"body"`
	Headers           http.Header `json:"headers"`
	Query             url.Values  `json:"query"`
	Model             string      `json:"model"`
	Stream            bool        `json:"stream"`
	Count             bool        `json:"count"`
	SessionID         string      `json:"sessionId"`
	ParentID          string      `json:"parentId"`
	LegacySessions    []string    `json:"legacySessions,omitempty"`
	AccountID         string      `json:"accountId"`
	AuthIndex         string      `json:"authIndex"`
	ProxyURL          string      `json:"proxyURL"`
	claimed, admitted bool
	sockets           map[net.Conn]struct{}
	cancel            context.CancelFunc
}

type StrictGate struct {
	Gateway     *Gateway
	Key         []byte
	OutboundURL string
	// Destination override is for isolated fixture DNS/dialing, never a client parameter.
	DialContext func(context.Context, string, string) (net.Conn, error)
	mu          sync.Mutex
	grants      map[string]*Grant
}

func (s *StrictGate) reference(kind, raw string) string {
	v, _ := identity.Reference(s.Key, "local", kind, raw)
	return v
}
func (s *StrictGate) request(ctx context.Context, method, path string, body any, out any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	u := s.Gateway.Proxy.ResolveReference(&url.URL{Path: "/v8/management" + path})
	if q := strings.IndexByte(path, '?'); q >= 0 {
		u.Path = "/v8/management" + path[:q]
		u.RawQuery = path[q+1:]
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.Gateway.ManagementKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.Gateway.Client.Do(req)
	if err != nil {
		return errors.New("proxy unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return errors.New("proxy operation rejected")
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

// Strict configuration must disable every implicit credential retry. Config
// changes are owner/admin operations; no inference client can mutate them.
func (s *StrictGate) configuration(ctx context.Context) ([]string, error) {
	var cfg struct {
		Access struct {
			Keys []string `json:"api-keys"`
		} `json:"access"`
		Routing struct {
			Retry struct {
				Count *int `json:"request-retry"`
			} `json:"retry"`
			Cooldown struct {
				Disabled bool `json:"disable-cooling"`
			} `json:"cooldown"`
		} `json:"routing"`
	}
	if err := s.request(ctx, "GET", "/config", nil, &cfg); err != nil {
		return nil, err
	}
	if cfg.Routing.Retry.Count == nil || *cfg.Routing.Retry.Count != 0 || !cfg.Routing.Cooldown.Disabled {
		return nil, errors.New("strict mode requires retries and host cooldown disabled")
	}
	return cfg.Access.Keys, nil
}

func strictError(w http.ResponseWriter, status int, code, message string, reset int64) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": map[string]any{"type": "api_error", "code": code, "message": message, "reset_at": reset}})
}

func (s *StrictGate) Public() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/readyz" {
			if s.Gateway.ready(r.Context()) != nil {
				unavailable(w)
				return
			}
			if _, err := s.configuration(r.Context()); err != nil {
				unavailable(w)
				return
			}
			w.WriteHeader(200)
			return
		}
		count := r.URL.Path == "/v1/messages/count_tokens"
		if r.Method != "POST" || (r.URL.Path != "/v1/messages" && !count) {
			strictError(w, 404, "crap_unsupported_protocol", "Strict mode currently supports Claude Messages and token counting only.", 0)
			return
		}
		keys, err := s.configuration(r.Context())
		if err != nil {
			strictError(w, 503, "crap_configuration", "Strict routing requires zero automatic retries and disabled host cooldown. Check proxy configuration.", 0)
			return
		}
		client := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if client == "" {
			client = r.Header.Get("X-Api-Key")
		}
		valid := false
		for _, key := range keys {
			if key != "" && subtle.ConstantTimeCompare([]byte(key), []byte(client)) == 1 {
				valid = true
			}
		}
		if !valid {
			strictError(w, 401, "crap_unauthorized", "Invalid client API key.", 0)
			return
		}
		if s.Gateway.ready(r.Context()) != nil {
			unavailable(w)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
		if err != nil {
			strictError(w, 413, "crap_request_size", "Request exceeds the supported size.", 0)
			return
		}
		var payload map[string]json.RawMessage
		if json.Unmarshal(body, &payload) != nil {
			strictError(w, 400, "crap_invalid_request", "Invalid JSON request.", 0)
			return
		}
		var model string
		var stream bool
		_ = json.Unmarshal(payload["model"], &model)
		_ = json.Unmarshal(payload["stream"], &stream)
		if model == "" || model == StrictModel {
			strictError(w, 400, "crap_invalid_model", "A Claude model is required.", 0)
			return
		}
		session, parent := Session(r.Header, body)
		var legacy []string
		if session != "" {
			// Preserve old live assignments when upgrading the earlier scheduler.
			// These are exact explicit-identity variants, never prompt-derived guesses.
			sum := sha256.Sum256([]byte("cli-proxy-api:caller-scope:v1\x00" + strings.TrimSpace(client)))
			for _, scope := range []string{hex.EncodeToString(sum[:]), client, "Bearer " + client} {
				for _, id := range []string{session, "claude:" + session, "header:" + session} {
					legacy = append(legacy, s.reference("session", scope+"/"+id))
				}
			}
		}
		if session == "" {
			session = "unbound:" + rand.Text()
		}
		session = s.reference("session", client+"/"+session)
		if parent != "" {
			parent = s.reference("session", client+"/"+parent)
		}
		s.Gateway.mu.Lock()
		if s.Gateway.draining {
			s.Gateway.mu.Unlock()
			unavailable(w)
			return
		}
		s.Gateway.active++
		s.Gateway.mu.Unlock()
		defer func() {
			s.Gateway.mu.Lock()
			defer s.Gateway.mu.Unlock()
			s.Gateway.active--
			if s.Gateway.active == 0 && s.Gateway.idle != nil {
				close(s.Gateway.idle)
				s.Gateway.idle = nil
			}
		}()
		ctx, cancel := context.WithCancel(r.Context())
		ticket := rand.Text() + rand.Text()
		g := &Grant{ID: ticket, Body: body, Headers: r.Header.Clone(), Query: r.URL.Query(), Model: model, Stream: stream, Count: count, SessionID: session, ParentID: parent, LegacySessions: legacy, sockets: map[net.Conn]struct{}{}, cancel: cancel}
		// Strip caller-supplied internal controls. Preserve provider-facing request headers.
		for key := range g.Headers {
			if strings.HasPrefix(strings.ToLower(key), "x-crap-") {
				g.Headers.Del(key)
			}
		}
		u, err := url.Parse(s.OutboundURL)
		if err != nil {
			cancel()
			unavailable(w)
			return
		}
		u.User = url.UserPassword("execution", ticket)
		g.ProxyURL = u.String()
		s.mu.Lock()
		if s.grants == nil {
			s.grants = map[string]*Grant{}
		}
		s.grants[ticket] = g
		s.mu.Unlock()
		defer s.revoke(ticket)
		// The host does not quiesce a plugin merely because its enabled flag
		// changes. Revoke active grants on loss of plugin readiness as well.
		// This polls only the local management API, never provider quotas.
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if s.Gateway.pluginReady(ctx) != nil {
						s.revoke(ticket)
						return
					}
				}
			}
		}()
		payload["model"], _ = json.Marshal(StrictModel)
		outer, _ := json.Marshal(payload)
		target := s.Gateway.Proxy.ResolveReference(&url.URL{Path: r.URL.Path, RawQuery: r.URL.RawQuery})
		req, _ := http.NewRequestWithContext(ctx, "POST", target.String(), bytes.NewReader(outer))
		req.Header = r.Header.Clone()
		req.Header.Del("Content-Length")
		req.Header.Set("X-Crap-Execution", ticket)
		req.Header.Set("X-Crap-Model", model)
		resp, err := s.Gateway.Client.Do(req)
		if err != nil {
			unavailable(w)
			return
		}
		defer func() { _ = resp.Body.Close() }()
		s.mu.Lock()
		admitted := g.admitted
		s.mu.Unlock()
		if !admitted && resp.StatusCode < 400 {
			unavailable(w)
			return
		}
		for _, key := range []string{"Content-Type", "Request-Id", "Retry-After"} {
			if v := resp.Header.Get(key); v != "" {
				w.Header().Set(key, v)
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		buf := make([]byte, 32<<10)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, err = w.Write(buf[:n]); err != nil {
					return
				}
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					// The public listener is HTTP/1. Close a truncated response rather
					// than letting net/http write a successful terminal chunk.
					if h, ok := w.(http.Hijacker); ok {
						if c, _, err := h.Hijack(); err == nil {
							_ = c.Close()
						}
					}
				}
				return
			}
		}
	})
}

func (s *StrictGate) revoke(ticket string) {
	s.mu.Lock()
	g := s.grants[ticket]
	delete(s.grants, ticket)
	if g != nil {
		for c := range g.sockets {
			_ = c.Close()
		}
	}
	s.mu.Unlock()
	if g != nil && g.cancel != nil {
		g.cancel()
	}
}

type credential struct {
	LastRefresh string `json:"last_refresh"`
	ID          string `json:"id"`
	Index       string `json:"auth_index"`
	Name        string `json:"name"`
	Provider    string `json:"provider"`
	Kind        string `json:"account_type"`
	Disabled    bool   `json:"disabled"`
	Runtime     bool   `json:"runtime_only"`
	Retry       *int   `json:"request_retry"`
}

func (s *StrictGate) choose(ctx context.Context, g *Grant) (policy.Decision, error) {
	var list struct {
		Files []credential `json:"files"`
	}
	if err := s.request(ctx, "GET", "/credentials", nil, &list); err != nil {
		return policy.Decision{}, err
	}
	p := control.StrictPick{SessionID: g.SessionID, ParentID: g.ParentID, Model: g.Model, LegacySessions: g.LegacySessions}
	ids := map[string]credential{}
	for _, a := range list.Files {
		if a.Provider != "claude" || a.Disabled || a.Runtime || a.Kind != "oauth" || (a.Retry != nil && *a.Retry > 0) {
			continue
		}
		var catalog struct {
			Models []struct {
				ID string `json:"id"`
			} `json:"models"`
		}
		if err := s.request(ctx, "GET", "/credentials/models?name="+url.QueryEscape(a.Name), nil, &catalog); err != nil {
			return policy.Decision{}, err
		}
		allowed := len(catalog.Models) == 0
		for _, m := range catalog.Models {
			if m.ID == g.Model {
				allowed = true
			}
		}
		if !allowed {
			continue
		}
		ref := s.reference("account", a.ID)
		ids[ref] = a
		p.Candidates = append(p.Candidates, policy.Candidate{ID: ref, Provider: "claude", Revision: a.LastRefresh})
	}
	var d policy.Decision
	if err := s.control(ctx, "/strict/pick", p, &d); err != nil {
		return d, err
	}
	if a, ok := ids[d.AccountID]; ok {
		s.mu.Lock()
		g.AccountID = a.ID
		g.Revision = a.LastRefresh
		g.AuthIndex = a.Index
		s.mu.Unlock()
	}
	return d, nil
}
func (s *StrictGate) control(ctx context.Context, path string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	target := s.Gateway.Control.ResolveReference(&url.URL{Path: path})
	req, _ := http.NewRequestWithContext(ctx, "POST", target.String(), bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+s.Gateway.ControlToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.Gateway.Client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return errors.New("routing unavailable")
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (s *StrictGate) Internal() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Crap-Service")), []byte(s.Gateway.ControlToken)) != 1 {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/account-read" {
			s.accountRead(w, r)
			return
		}
		ticket := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		s.mu.Lock()
		g := s.grants[ticket]
		if g == nil {
			s.mu.Unlock()
			w.WriteHeader(410)
			return
		}
		if r.URL.Path == "/revoke" && r.Method == "POST" {
			s.mu.Unlock()
			s.revoke(ticket)
			w.WriteHeader(200)
			return
		}
		if r.URL.Path == "/claim" && r.Method == "POST" {
			if g.claimed {
				s.mu.Unlock()
				w.WriteHeader(409)
				return
			}
			g.claimed = true
			s.mu.Unlock()
			d, err := s.choose(r.Context(), g)
			if err != nil {
				unavailable(w)
				return
			}
			s.mu.Lock()
			if s.grants[ticket] != g {
				s.mu.Unlock()
				w.WriteHeader(410)
				return
			}
			if g.AccountID == "" {
				s.mu.Unlock()
				strictError(w, 429, "crap_no_usable_account", d.Reason, d.ResetAt)
				return
			}
			g.admitted = true
			_ = json.NewEncoder(w).Encode(g)
			s.mu.Unlock()
			return
		}
		admitted := g.admitted
		s.mu.Unlock()
		if r.URL.Path == "/failure" && r.Method == "POST" && admitted {
			var f struct {
				Reason string `json:"reason"`
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&f) != nil {
				w.WriteHeader(400)
				return
			}
			if err := s.control(r.Context(), "/strict/failure", map[string]any{"accountId": s.reference("account", g.AccountID), "model": g.Model, "revision": g.Revision, "reason": f.Reason}, nil); err != nil {
				unavailable(w)
				return
			}
			w.WriteHeader(200)
			return
		}
		if r.URL.Path == "/count" && r.Method == "POST" && admitted && g.Count {
			s.count(w, r, g)
			return
		}
		w.WriteHeader(404)
	})
}

func (s *StrictGate) Egress() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" {
			w.WriteHeader(403)
			return
		}
		copyReq := r.Clone(r.Context())
		copyReq.Header = r.Header.Clone()
		copyReq.Header.Set("Authorization", r.Header.Get("Proxy-Authorization"))
		user, ticket, ok := copyReq.BasicAuth()
		s.mu.Lock()
		g := s.grants[ticket]
		authorized := ok && user == "execution" && g != nil && g.admitted && r.Host == "api.anthropic.com:443"
		s.mu.Unlock()
		// Refresh and login use a separate provider origin. Default proxy traffic
		// cannot reach the inference origin, even if optional host hooks are skipped.
		refresh := !ok && r.Host == "platform.claude.com:443"
		if !authorized && !refresh {
			w.WriteHeader(403)
			return
		}
		dial := s.DialContext
		if dial == nil {
			dial = (&net.Dialer{}).DialContext
		}
		up, err := dial(r.Context(), "tcp", r.Host)
		if err != nil {
			w.WriteHeader(502)
			return
		}
		h, ok := w.(http.Hijacker)
		if !ok {
			_ = up.Close()
			w.WriteHeader(500)
			return
		}
		down, buff, err := h.Hijack()
		if err != nil {
			_ = up.Close()
			return
		}
		if authorized {
			s.mu.Lock()
			if s.grants[ticket] != g {
				s.mu.Unlock()
				_ = up.Close()
				_ = down.Close()
				return
			}
			g.sockets[up] = struct{}{}
			g.sockets[down] = struct{}{}
			s.mu.Unlock()
		}
		defer func() {
			_ = up.Close()
			_ = down.Close()
			if authorized {
				s.mu.Lock()
				delete(g.sockets, up)
				delete(g.sockets, down)
				s.mu.Unlock()
			}
		}()
		_, _ = buff.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buff.Flush()
		done := make(chan struct{})
		go func() { _, _ = io.Copy(up, buff); _ = up.Close(); close(done) }()
		_, _ = io.Copy(down, up)
		_ = down.Close()
		<-done
	})
}

func (s *StrictGate) apiCall(ctx context.Context, g *Grant, method, path string, body []byte) (json.RawMessage, error) {
	var result json.RawMessage
	err := s.request(ctx, "POST", "/requests/api-call", map[string]any{"auth_index": g.AuthIndex, "method": method, "url": "https://api.anthropic.com" + path, "proxy_url": g.ProxyURL, "header": map[string]string{"Authorization": "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01", "Content-Type": "application/json"}, "data": string(body)}, &result)
	return result, err
}
func (s *StrictGate) count(w http.ResponseWriter, r *http.Request, g *Grant) {
	raw, err := s.apiCall(r.Context(), g, "POST", "/v1/messages/count_tokens", g.Body)
	if err != nil {
		unavailable(w)
		return
	}
	_, _ = w.Write(raw)
}
func (s *StrictGate) accountRead(w http.ResponseWriter, r *http.Request) {
	var q struct {
		AuthIndex string `json:"authIndex"`
		Endpoint  string `json:"endpoint"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&q) != nil || q.AuthIndex == "" || (q.Endpoint != "usage" && q.Endpoint != "profile") {
		w.WriteHeader(400)
		return
	}
	ticket := rand.Text() + rand.Text()
	u, _ := url.Parse(s.OutboundURL)
	u.User = url.UserPassword("execution", ticket)
	g := &Grant{AuthIndex: q.AuthIndex, ProxyURL: u.String(), admitted: true, sockets: map[net.Conn]struct{}{}}
	s.mu.Lock()
	if s.grants == nil {
		s.grants = map[string]*Grant{}
	}
	s.grants[ticket] = g
	s.mu.Unlock()
	defer s.revoke(ticket)
	raw, err := s.apiCall(r.Context(), g, "GET", "/api/oauth/"+q.Endpoint, nil)
	if err != nil {
		unavailable(w)
		return
	}
	_, _ = w.Write(raw)
}

// Session reads explicit Claude Code identity only. No prompt text is hashed or
// stored. Requests without identity receive isolated ephemeral bindings.
func Session(h http.Header, body []byte) (string, string) {
	var p struct {
		Session  string `json:"session_id"`
		Parent   string `json:"parent_session_id"`
		Metadata struct {
			UserID string `json:"user_id"`
			Parent string `json:"parent_session_id"`
		} `json:"metadata"`
	}
	_ = json.Unmarshal(body, &p)
	session := p.Session
	parent := p.Parent
	if parent == "" {
		parent = p.Metadata.Parent
	}
	var nested struct {
		Session string `json:"session_id"`
		Parent  string `json:"parent_session_id"`
	}
	if json.Unmarshal([]byte(p.Metadata.UserID), &nested) == nil {
		if session == "" {
			session = nested.Session
		}
		if parent == "" {
			parent = nested.Parent
		}
	} else if _, suffix, ok := strings.Cut(p.Metadata.UserID, "_session_"); ok && session == "" {
		session = suffix
	}
	for _, key := range []string{"X-Claude-Code-Session-Id", "X-Session-Id", "Session_id", "Session-Id"} {
		if v := h.Get(key); v != "" {
			session = v
			break
		}
	}
	for _, key := range []string{"X-Parent-Session-Id", "X-Claude-Code-Parent-Session-Id", "Parent-Session-Id"} {
		if v := h.Get(key); v != "" {
			parent = v
			break
		}
	}
	if len(session) > 512 {
		session = ""
	}
	if len(parent) > 512 {
		parent = ""
	}
	return session, parent
}
