// A separate embedded tailnet node. No host VPN settings or public listeners.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

type config struct {
	PanelURL     string   `json:"panelURL"`
	ProxyURL     string   `json:"proxyURL"`
	Hostname     string   `json:"hostname"`
	Dir          string   `json:"dir"`
	AuthKey      string   `json:"authKey"`
	AllowedUsers []string `json:"allowedUsers"`
	Dashboard    bool     `json:"dashboard"`
	API          bool     `json:"api"`
}
type reporter struct{ mu sync.Mutex }

func (r *reporter) send(v any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(v)
}
func main() {
	if err := run(); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"phase": "error", "error": "Private access stopped. Check tailnet login, HTTPS settings and the local services."})
		os.Exit(1)
	}
}
func run() error {
	// Parent pipe closure ends the node; it cannot survive as an orphan gateway.
	reader := bufio.NewReaderSize(os.Stdin, 65536)
	line, err := reader.ReadBytes('\n')
	if err != nil || len(line) > 65536 {
		return errors.New("invalid configuration")
	}
	var c config
	if json.Unmarshal(line, &c) != nil || len(c.AllowedUsers) == 0 || (!c.Dashboard && !c.API) {
		return errors.New("invalid configuration")
	}
	if c.PanelURL == "" {
		c.PanelURL = "http://127.0.0.1:3001"
	}
	if c.ProxyURL == "" {
		c.ProxyURL = "http://127.0.0.1:8317"
	}
	for _, raw := range []string{c.PanelURL, c.ProxyURL} {
		u, e := url.Parse(raw)
		if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return errors.New("invalid backend")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, reader); cancel() }()
	report := &reporter{}
	server := &tsnet.Server{Hostname: c.Hostname, Dir: c.Dir, AuthKey: c.AuthKey, Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
	if err := server.Start(); err != nil {
		return err
	}
	defer func() { _ = server.Close() }()
	client, err := server.LocalClient()
	if err != nil {
		return err
	}
	ready := make(chan error, 1)
	go func() { _, e := server.Up(ctx); ready <- e }()
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-ready:
			if e != nil {
				return e
			}
			goto connected
		case <-ticker.C:
			status, e := client.Status(ctx)
			if e == nil {
				report.send(map[string]string{"phase": "connecting", "authUrl": status.AuthURL})
			}
		}
	}
connected:
	status, err := client.Status(ctx)
	if err != nil {
		return err
	}
	if len(status.CertDomains) == 0 {
		report.send(map[string]string{"phase": "needs-https", "error": "Enable HTTPS certificates and MagicDNS in the Tailscale admin console, then reconnect."})
		<-ctx.Done()
		return nil
	}
	hostname := status.CertDomains[0]
	who := func(r *http.Request) (string, bool) {
		w, e := client.WhoIs(r.Context(), r.RemoteAddr)
		if e != nil || w.Node == nil || w.UserProfile == nil || len(w.Node.Tags) > 0 {
			return "", false
		}
		return w.UserProfile.LoginName, true
	}
	failures := make(chan error, 2)
	for _, entry := range []struct {
		enabled        bool
		port, upstream string
		api            bool
	}{{c.Dashboard, ":443", c.PanelURL, false}, {c.API, ":8443", c.ProxyURL, true}} {
		if !entry.enabled {
			continue
		}
		listener, e := server.ListenTLS("tcp", entry.port)
		if e != nil {
			return e
		}
		target, _ := url.Parse(entry.upstream)
		handler := gatewayHandler(target, "https://"+hostname+strings.TrimSuffix(entry.port, ":443"), c.AllowedUsers, entry.api, who)
		web := &http.Server{Handler: handler, ErrorLog: log.New(io.Discard, "", 0)}
		go func() { <-ctx.Done(); _ = web.Close() }()
		go func() { failures <- web.Serve(listener) }()
	}
	for {
		state := map[string]string{"phase": "online"}
		if c.Dashboard {
			state["dashboardUrl"] = "https://" + hostname
		}
		if c.API {
			state["apiUrl"] = "https://" + hostname + ":8443"
		}
		report.send(state)
		select {
		case <-ctx.Done():
			return nil
		case e := <-failures:
			return e
		case <-ticker.C:
			status, e := client.Status(ctx)
			if e != nil || status.BackendState != "Running" {
				return errors.New("tailnet offline")
			}
		}
	}
}

func gatewayHandler(target *url.URL, origin string, users []string, api bool, who func(*http.Request) (string, bool)) http.Handler {
	proxy := &httputil.ReverseProxy{Rewrite: func(p *httputil.ProxyRequest) {
		p.SetURL(target)
		p.Out.Host = target.Host
		p.Out.Header.Del("Forwarded")
		p.Out.Header.Del("X-Forwarded-For")
		p.Out.Header.Del("X-Forwarded-Host")
		p.Out.Header.Del("X-Forwarded-Proto")
		if p.In.Header.Get("Origin") != "" {
			p.Out.Header.Set("Origin", target.String())
		}
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, e error) { http.Error(w, "Local service unavailable", 502) }, ErrorLog: log.New(io.Discard, "", 0)}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		login, ok := who(r)
		allowed := false
		for _, user := range users {
			if strings.EqualFold(user, login) && login != "" {
				allowed = true
			}
		}
		if !ok || !allowed {
			http.Error(w, "This Tailscale identity is not allowed to access this workspace.", 403)
			return
		}
		if r.Header.Get("Origin") != "" && r.Header.Get("Origin") != origin {
			http.Error(w, "Cross-origin request denied", 403)
			return
		}
		if r.Host != strings.TrimPrefix(origin, "https://") {
			http.Error(w, "Unexpected host", 403)
			return
		}
		if api {
			allowedPath := (r.Method == "GET" && r.URL.Path == "/v1/models") || (r.Method == "POST" && (r.URL.Path == "/v1/messages" || r.URL.Path == "/v1/messages/count_tokens" || r.URL.Path == "/v1/chat/completions" || r.URL.Path == "/v1/responses" || r.URL.Path == "/v1/completions" || r.URL.Path == "/v1/embeddings"))
			if !allowedPath {
				http.NotFound(w, r)
				return
			}
			if r.Header.Get("Authorization") == "" && r.Header.Get("X-Api-Key") == "" {
				http.Error(w, "A client API key is required", 401)
				return
			}
		}
		// Let the panel set cache policy for public build assets after identity checks.
		// API responses, documents and denied requests remain non-cacheable here.
		if !api && (r.Method == http.MethodGet || r.Method == http.MethodHead) && strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Del("Cache-Control")
		}
		proxy.ServeHTTP(w, r)
	})
}
