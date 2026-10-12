package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestGatewayIdentityOriginAndInferenceBoundary(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+r.Host {
			t.Error("origin was not rewritten after validation")
		}
		if r.Header.Get("X-Forwarded-Host") != "" {
			t.Error("untrusted forwarding header leaked")
		}
		raw, _ := io.ReadAll(r.Body)
		_, _ = w.Write(raw)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	login := "owner@example.com"
	identity := func(*http.Request) (string, bool) { return login, true }
	for _, api := range []bool{false, true} {
		origin := "https://crap.example.ts.net"
		if api {
			origin += ":8443"
		}
		handler := gatewayHandler(target, origin, []string{"owner@example.com"}, api, identity)
		call := func(path, requestOrigin, key string) int {
			r := httptest.NewRequest("POST", origin+path, strings.NewReader(`{"model":"fixture","stream":true}`))
			r.Header.Set("Origin", requestOrigin)
			r.Header.Set("Authorization", key)
			r.Header.Set("Tailscale-User-Login", "owner@example.com")
			r.Header.Set("X-Forwarded-Host", "evil.example")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			return w.Code
		}
		login = "intruder@example.com"
		before := calls
		if got := call("/v1/messages", origin, "Bearer fixture"); got != 403 {
			t.Fatalf("identity: %d", got)
		}
		login = "owner@example.com"
		if got := call("/v1/messages", "https://evil.example", "Bearer fixture"); got != 403 {
			t.Fatalf("origin: %d", got)
		}
		if calls != before {
			t.Fatal("denied requests reached upstream")
		}
		if api {
			if got := call("/v8/management/config", origin, "Bearer fixture"); got != 404 {
				t.Fatalf("management exposed: %d", got)
			}
			if got := call("/v1/messages", origin, ""); got != 401 {
				t.Fatalf("missing key accepted: %d", got)
			}
		}
		if got := call("/v1/messages", origin, "Bearer fixture"); got != 200 {
			t.Fatalf("authorized request: %d", got)
		}
	}
}

func TestGatewayAllowsStaticCacheOnlyAfterIdentityCheck(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	allowed := true
	handler := gatewayHandler(target, "https://crap.example.ts.net", []string{"owner@example.com"}, false, func(*http.Request) (string, bool) { return "owner@example.com", allowed })
	for _, pathname := range []string{"/assets/index-abcdefgh.js", "/api/affinity/state", "/"} {
		r := httptest.NewRequest("GET", "https://crap.example.ts.net"+pathname, nil)
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		cache := w.Header().Values("Cache-Control")
		if strings.HasPrefix(pathname, "/assets/") {
			if len(cache) != 1 || cache[0] != "private, max-age=31536000, immutable" {
				t.Fatalf("asset policy: %v", cache)
			}
			if w.Header().Get("Content-Encoding") != "gzip" || w.Header().Get("Vary") != "Accept-Encoding" {
				t.Fatal("compression headers lost")
			}
		} else if len(cache) == 0 || cache[0] != "no-store" {
			t.Fatalf("dynamic policy: %v", cache)
		}
	}
	allowed = false
	before := calls
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "https://crap.example.ts.net/assets/index-abcdefgh.js", nil))
	if w.Code != 403 || w.Header().Get("Cache-Control") != "no-store" || calls != before {
		t.Fatal("denied static request was cacheable or reached upstream")
	}
}
