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
