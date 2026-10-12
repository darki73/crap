//go:build !windows

package main

import (
	"bufio"
	"encoding/json"
	log "github.com/sirupsen/logrus"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
)

func TestGatewayChild(t *testing.T) {
	if os.Getenv("CRAP_GATEWAY_CHILD") != "1" {
		return
	}
	log.SetFormatter(&log.JSONFormatter{})
	if err := run(); err != nil {
		t.Fatal(err)
	}
}

func TestSIGTERMDrainsAnActualGatewayProcess(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/plugins" {
			_, _ = io.WriteString(w, `{"plugins_enabled":true,"plugins":[{"id":"affinity-router","registered":true,"effective_enabled":true}]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "data: last\n\n")
	}))
	defer upstream.Close()
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer control.Close()
	child := exec.Command(os.Args[0], "-test.run=^TestGatewayChild$")
	child.Env = append(os.Environ(), "CRAP_GATEWAY_CHILD=1", "AFFINITY_GATEWAY_LISTEN=127.0.0.1:0", "PROXY_URL="+upstream.URL, "AFFINITY_CONTROL_URL="+control.URL, "MANAGEMENT_KEY="+strings.Repeat("m", 32), "AFFINITY_CONTROL_TOKEN="+strings.Repeat("c", 32))
	stderr, err := child.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill() }()
	address := make(chan string, 1)
	draining := make(chan struct{})
	go func() {
		scan := bufio.NewScanner(stderr)
		for scan.Scan() {
			var entry map[string]any
			if json.Unmarshal(scan.Bytes(), &entry) != nil {
				continue
			}
			if a, ok := entry["address"].(string); ok {
				address <- a
			}
			if entry["msg"] == "Gateway draining active requests" {
				close(draining)
			}
		}
	}()
	response, err := http.Get("http://" + <-address + "/v1/messages")
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	if err = child.Process.Signal(syscall.SIGTERM); err != nil {
		close(release)
		t.Fatal(err)
	}
	<-draining
	close(release)
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || string(body) != "data: first\n\ndata: last\n\n" {
		t.Fatal("process shutdown truncated stream", err)
	}
	if err = child.Wait(); err != nil {
		t.Fatal("gateway shutdown failed", err)
	}
}
