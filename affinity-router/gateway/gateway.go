// Package gateway provides the checked public inference entrypoint. Management
// stays on the private proxy network. Checks are never cached between requests.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
)

type Gateway struct {
	Proxy, Control              *url.URL
	ManagementKey, ControlToken string
	Client                      *http.Client
	Strict                      *StrictGate
	mu                          sync.Mutex
	draining                    bool
	active                      int
	idle                        chan struct{}
}

func (g *Gateway) Drain()      { g.mu.Lock(); g.draining = true; g.mu.Unlock() }
func (g *Gateway) Active() int { g.mu.Lock(); defer g.mu.Unlock(); return g.active }

// Wait also covers upgraded connections, which http.Server.Shutdown does not.
func (g *Gateway) Wait() {
	g.mu.Lock()
	if g.active == 0 {
		g.mu.Unlock()
		return
	}
	if g.idle == nil {
		g.idle = make(chan struct{})
	}
	idle := g.idle
	g.mu.Unlock()
	<-idle
}
func (g *Gateway) ready(ctx context.Context) error {
	g.mu.Lock()
	draining := g.draining
	g.mu.Unlock()
	if draining {
		return errors.New("draining")
	}
	if err := g.pluginReady(ctx); err != nil {
		return err
	}
	return g.read(ctx, g.Control, "/ready", g.ControlToken, nil)
}
func (g *Gateway) pluginReady(ctx context.Context) error {
	var plugins struct {
		Enabled bool `json:"plugins_enabled"`
		Plugins []struct {
			ID         string `json:"id"`
			Registered bool   `json:"registered"`
			Enabled    bool   `json:"effective_enabled"`
		} `json:"plugins"`
	}
	if err := g.read(ctx, g.Proxy, "/v8/management/plugins", g.ManagementKey, &plugins); err != nil {
		return err
	}
	found := false
	for _, p := range plugins.Plugins {
		if p.ID == "affinity-router" && p.Registered && p.Enabled {
			found = true
		}
	}
	if !plugins.Enabled || !found {
		return errors.New("required plugin unavailable")
	}
	return nil
}
func (g *Gateway) read(ctx context.Context, base *url.URL, path, token string, value any) error {
	target := base.ResolveReference(&url.URL{Path: path})
	req, err := http.NewRequestWithContext(ctx, "GET", target.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := g.Client.Do(req)
	if err != nil {
		return errors.New("dependency unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return errors.New("dependency not ready")
	}
	if value != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(value)
	}
	_, err = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return err
}
func unavailable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "5")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = io.WriteString(w, `{"error":{"type":"service_unavailable","code":"crap_not_ready","message":"Routing is not ready. Check proxy, plugin and control service health."}}`)
}
func (g *Gateway) Handler() http.Handler {
	if g.Strict != nil {
		return g.Strict.Public()
	}
	proxy := &httputil.ReverseProxy{
		Rewrite:       func(p *httputil.ProxyRequest) { p.SetURL(g.Proxy); p.Out.Host = g.Proxy.Host },
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler:  func(w http.ResponseWriter, r *http.Request, err error) { unavailable(w) },
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/readyz" && r.Method == "GET" {
			if g.ready(r.Context()) != nil {
				unavailable(w)
			} else {
				w.WriteHeader(200)
			}
			return
		}
		// Only supported inference API namespaces cross this boundary. In
		// particular, encoded path traversal must not reach management handlers.
		if !(strings.HasPrefix(r.URL.Path, "/v1/") || strings.HasPrefix(r.URL.Path, "/v1beta/")) || strings.Contains(r.URL.Path, "..") || strings.ContainsAny(r.URL.Path, "\\%") {
			http.NotFound(w, r)
			return
		}
		if g.ready(r.Context()) != nil {
			unavailable(w)
			return
		}
		g.mu.Lock()
		if g.draining {
			g.mu.Unlock()
			unavailable(w)
			return
		}
		g.active++
		g.mu.Unlock()
		defer func() {
			g.mu.Lock()
			g.active--
			if g.active == 0 && g.idle != nil {
				close(g.idle)
				g.idle = nil
			}
			g.mu.Unlock()
		}()
		proxy.ServeHTTP(w, r)
	})
}
