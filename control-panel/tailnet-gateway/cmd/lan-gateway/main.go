// CRAP's optional mTLS ingress. It never contacts a model provider directly.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const clientIdentity = "urn:crap:lan:traefik"

type settings struct {
	origin     string
	panel, api *url.URL
	certDir    string
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func readSettings() (settings, error) {
	c := settings{origin: os.Getenv("CRAP_LAN_ORIGIN"), certDir: env("CRAP_LAN_TLS_DIR", "/run/crap-lan")}
	origin, err := url.Parse(c.origin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return c, errors.New("invalid LAN origin")
	}
	for _, entry := range []struct {
		raw string
		dst **url.URL
	}{{env("CRAP_LAN_PANEL_URL", "http://panel:3000"), &c.panel}, {env("CRAP_LAN_API_URL", "http://api:8319"), &c.api}} {
		u, err := url.Parse(entry.raw)
		if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return c, errors.New("invalid local backend")
		}
		*entry.dst = u
	}
	return c, nil
}

// Resolve Kubernetes' projected Secret generation once, so cert/key/CA always
// come from one atomic update. No subPath mount or process restart is needed.
func loadTLS(dir string) (*tls.Config, error) {
	if generation, err := filepath.EvalSymlinks(filepath.Join(dir, "..data")); err == nil {
		dir = generation
	}
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key"))
	if err != nil {
		return nil, errors.New("LAN certificate unavailable")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil || time.Now().Before(leaf.NotBefore) || !time.Now().Before(leaf.NotAfter) {
		return nil, errors.New("LAN certificate is not current")
	}
	ca, err := os.ReadFile(filepath.Join(dir, "ca.crt"))
	pool := x509.NewCertPool()
	if err != nil || !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("LAN trust bundle unavailable")
	}
	intermediates := x509.NewCertPool()
	for _, der := range cert.Certificate[1:] {
		c, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, errors.New("invalid LAN certificate chain")
		}
		intermediates.AddCert(c)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		return nil, errors.New("LAN certificate does not match current trust bundle")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert,
		// Disable tickets: every new connection must validate the current trust bundle.
		SessionTicketsDisabled: true, NextProtos: []string{"http/1.1"}, VerifyConnection: verifyClient}, nil
}
func verifyClient(state tls.ConnectionState) error {
	if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 {
		return errors.New("client certificate required")
	}
	cert := state.PeerCertificates[0]
	if time.Now().Before(cert.NotBefore) || !time.Now().Before(cert.NotAfter) {
		return errors.New("client certificate expired")
	}
	for _, uri := range cert.URIs {
		if uri.String() == clientIdentity {
			return nil
		}
	}
	return errors.New("client identity denied")
}
func apiPath(method, path string) bool {
	if method == http.MethodGet && path == "/v1/models" {
		return true
	}
	if method != http.MethodPost {
		return false
	}
	switch path {
	case "/v1/messages", "/v1/messages/count_tokens", "/v1/chat/completions", "/v1/responses", "/v1/completions", "/v1/embeddings":
		return true
	}
	return false
}
func handler(c settings) http.Handler {
	makeProxy := func(target *url.URL, panel bool) *httputil.ReverseProxy {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil // Never send private service traffic through an environment proxy.
		transport.ResponseHeaderTimeout = 0
		return &httputil.ReverseProxy{Transport: transport, FlushInterval: -1,
			Rewrite: func(p *httputil.ProxyRequest) {
				p.SetURL(target)
				p.Out.Host = target.Host
				if panel {
					p.Out.Host = strings.TrimPrefix(c.origin, "https://")
				}
				for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-Ip", "X-Forwarded-Client-Cert"} {
					p.Out.Header.Del(name)
				}
			}, ErrorLog: log.New(io.Discard, "", 0), ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				http.Error(w, "CRAP service unavailable", http.StatusBadGateway)
			},
		}
	}
	panel, api := makeProxy(c.panel, true), makeProxy(c.api, false)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.TLS == nil || verifyClient(*r.TLS) != nil {
			http.Error(w, "Client identity required", http.StatusForbidden)
			return
		}
		if r.Host != strings.TrimPrefix(c.origin, "https://") || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != c.origin) {
			http.Error(w, "Unexpected host or origin", http.StatusForbidden)
			return
		}
		if r.URL.IsAbs() || r.Method == http.MethodConnect {
			http.Error(w, "Invalid request", http.StatusBadRequest)
			return
		}
		if r.URL.Path == "/v1" || strings.HasPrefix(r.URL.Path, "/v1/") {
			if !apiPath(r.Method, r.URL.Path) || r.URL.RawPath != "" {
				http.NotFound(w, r)
				return
			}
			if r.Header.Get("Authorization") == "" && r.Header.Get("X-Api-Key") == "" {
				http.Error(w, "A client API key is required", http.StatusUnauthorized)
				return
			}
			api.ServeHTTP(w, r)
			return
		}
		// These are proxy/control endpoints, never dashboard resources.
		for _, prefix := range []string{"/v0/", "/v8/", "/readyz", "/healthz"} {
			if strings.HasPrefix(r.URL.Path, prefix) {
				http.NotFound(w, r)
				return
			}
		}
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) && strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Del("Cache-Control")
		}
		panel.ServeHTTP(w, r)
	})
}
func run(check bool) error {
	c, err := readSettings()
	if err != nil {
		return err
	}
	if _, err = loadTLS(c.certDir); err != nil {
		return err
	}
	if check {
		return nil
	}
	server := &http.Server{Addr: ":9443", Handler: handler(c), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second,
		ErrorLog: log.New(io.Discard, "", 0), TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) { return loadTLS(c.certDir) }}}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		drain, cancel := context.WithTimeout(context.Background(), 110*time.Second)
		defer cancel()
		_ = server.Shutdown(drain)
	}()
	err = server.ListenAndServeTLS("", "")
	if errors.Is(err, http.ErrServerClosed) {
		<-done
		return nil
	}
	return err
}
func main() {
	check := flag.Bool("check", false, "Validate configuration and mounted certificates without listening")
	flag.Parse()
	if run(*check) != nil {
		log.Print("CRAP LAN entrypoint unavailable; check its configuration and certificate resources.")
		os.Exit(1)
	}
}
