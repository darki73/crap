package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAdmissionFailuresNeverReachInference(t *testing.T) {
	for _, failure := range []string{"disabled", "missing", "unregistered", "control", "malformed", "redirect", "healthy"} {
		t.Run(failure, func(t *testing.T) {
			var hits atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v8/management/plugins" {
					if r.Header.Get("Authorization") != "Bearer management-fixture" {
						t.Error("missing management credential")
					}
					if failure == "redirect" {
						http.Redirect(w, r, "/v1/messages", 302)
						return
					}
					if failure == "malformed" {
						_, _ = io.WriteString(w, "{}")
						return
					}
					id := "affinity-router"
					if failure == "missing" {
						id = "other"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"plugins_enabled": failure != "disabled", "plugins": []any{map[string]any{"id": id, "registered": failure != "unregistered", "effective_enabled": failure != "disabled"}}})
					return
				}
				hits.Add(1)
				if r.Header.Get("Authorization") != "Bearer client-fixture" {
					t.Error("client credential changed")
				}
				body, _ := io.ReadAll(r.Body)
				_, _ = w.Write(body)
			}))
			defer upstream.Close()
			ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer control-fixture" {
					t.Error("missing control credential")
				}
				if failure == "control" {
					w.WriteHeader(503)
				}
			}))
			defer ctrl.Close()
			p, _ := url.Parse(upstream.URL)
			c, _ := url.Parse(ctrl.URL)
			g := &Gateway{Proxy: p, Control: c, ManagementKey: "management-fixture", ControlToken: "control-fixture", Client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
			req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"fixture":true}`))
			req.Header.Set("Authorization", "Bearer client-fixture")
			res := httptest.NewRecorder()
			g.Handler().ServeHTTP(res, req)
			if failure == "healthy" {
				if res.Code != 200 || hits.Load() != 1 || res.Body.String() != `{"fixture":true}` {
					t.Fatal("healthy forwarding changed")
				}
			} else if res.Code != 503 || hits.Load() != 0 {
				t.Fatalf("unsafe admission: status=%d hits=%d", res.Code, hits.Load())
			}
			for _, path := range []string{"/v8/management/config", "/v1/../v8/management/config", "/v1/%2e%2e/v8/management/config", "/v1/%252e%252e/v8/management/config"} {
				res := httptest.NewRecorder()
				g.Handler().ServeHTTP(res, httptest.NewRequest("GET", path, nil))
				if res.Code != 404 {
					t.Errorf("exposed path %s", path)
				}
			}
		})
	}
}

func TestDrainKeepsStreamAndRejectsNewRequests(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/plugins" {
			_, _ = io.WriteString(w, `{"plugins_enabled":true,"plugins":[{"id":"affinity-router","registered":true,"effective_enabled":true}]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-release
		_, _ = io.WriteString(w, "data: last\n\n")
	}))
	defer upstream.Close()
	ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer ctrl.Close()
	p, _ := url.Parse(upstream.URL)
	c, _ := url.Parse(ctrl.URL)
	g := &Gateway{Proxy: p, Control: c, Client: upstream.Client()}
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	response, err := http.Get(server.URL + "/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	<-started
	g.Drain()
	denied := httptest.NewRecorder()
	g.Handler().ServeHTTP(denied, httptest.NewRequest("POST", "/v1/messages", nil))
	if denied.Code != 503 {
		t.Fatal("drain admitted new request")
	}
	if g.Active() != 1 {
		t.Fatal("active stream not tracked")
	}
	close(release)
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || !strings.Contains(string(body), "data: last") {
		t.Fatal("drain truncated stream")
	}
	g.Wait()
	if g.Active() != 0 {
		t.Fatal("stream not released")
	}
}

func TestClientCancellationReachesUpstream(t *testing.T) {
	cancelled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/plugins" {
			_, _ = io.WriteString(w, `{"plugins_enabled":true,"plugins":[{"id":"affinity-router","registered":true,"effective_enabled":true}]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}))
	defer upstream.Close()
	ctrl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer ctrl.Close()
	p, _ := url.Parse(upstream.URL)
	c, _ := url.Parse(ctrl.URL)
	g := &Gateway{Proxy: p, Control: c, Client: upstream.Client()}
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	response, err := http.Get(server.URL + "/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	<-cancelled
	g.Drain()
	g.Wait()
}
