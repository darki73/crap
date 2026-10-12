package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

func TestStrictModelDiscovery(t *testing.T) {
	var calls atomic.Int32
	var ready atomic.Bool
	ready.Store(true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v8/management/config":
			_, _ = io.WriteString(w, `{"access":{"api-keys":["client-fixture"]},"routing":{"retry":{"request-retry":0},"cooldown":{"disable-cooling":true}}}`)
		case "/v8/management/plugins":
			if !ready.Load() {
				w.WriteHeader(503)
				return
			}
			_, _ = io.WriteString(w, `{"plugins_enabled":true,"plugins":[{"id":"affinity-router","registered":true,"effective_enabled":true}]}`)
		case "/v1/models":
			calls.Add(1)
			if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer client-fixture" || r.Header.Get("X-Crap-Grant") != "" || r.URL.RawQuery != "" {
				t.Error("model discovery leaked or changed request data")
			}
			_, _ = io.WriteString(w, `{"data":[{"id":"claude-fixture"}]}`)
		default:
			t.Errorf("unexpected proxy request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ready" {
			t.Errorf("discovery created control state: %s", r.URL.Path)
		}
	}))
	defer control.Close()
	p, _ := url.Parse(upstream.URL)
	c, _ := url.Parse(control.URL)
	g := &Gateway{Proxy: p, Control: c, ManagementKey: "management-fixture", ControlToken: "control-fixture", Client: upstream.Client()}
	g.Strict = &StrictGate{Gateway: g}
	for _, tc := range []struct {
		method, path, key string
		code              int
	}{
		{"GET", "/v1/models", "", 401},
		{"GET", "/v1/models", "wrong-key", 401},
		{"POST", "/v1/models", "client-fixture", 404},
		{"GET", "/v8/management/config", "client-fixture", 404},
		{"GET", "/v1/models?ignored=true", "client-fixture", 200},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set("X-Api-Key", tc.key)
		req.Header.Set("X-Crap-Grant", "untrusted-fixture")
		res := httptest.NewRecorder()
		g.Handler().ServeHTTP(res, req)
		if res.Code != tc.code {
			t.Fatalf("%s %s: got %d want %d", tc.method, tc.path, res.Code, tc.code)
		}
		if res.Code == 200 && res.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("model results became cacheable")
		}
	}
	if calls.Load() != 1 || len(g.Strict.grants) != 0 {
		t.Fatal("discovery bypassed checks or created execution state")
	}
	ready.Store(false)
	req := httptest.NewRequest("GET", "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer client-fixture")
	res := httptest.NewRecorder()
	g.Handler().ServeHTTP(res, req)
	if res.Code != 503 || calls.Load() != 1 {
		t.Fatal("discovery bypassed plugin readiness")
	}
}
