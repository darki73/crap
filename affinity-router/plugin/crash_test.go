//go:build !windows

package plugin

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestSpoolCrashChild(t *testing.T) {
	if os.Getenv("CRAP_SPOOL_CHILD") != "1" {
		return
	}
	r := &Runtime{Spool: os.Getenv("CRAP_SPOOL_DIRECTORY")}
	if err := r.enqueue("/usage", map[string]any{"EventID": "fixture-crash-event"}); err != nil {
		t.Fatal(err)
	}
	fmt.Println("durable")
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func TestSIGKILLRetainsAcknowledgedSpoolForReplay(t *testing.T) {
	directory := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestSpoolCrashChild$")
	child.Env = append(os.Environ(), "CRAP_SPOOL_CHILD=1", "CRAP_SPOOL_DIRECTORY="+directory)
	out, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	in, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = in.Close() }()
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill() }()
	scan := bufio.NewScanner(out)
	if !scan.Scan() || scan.Text() != "durable" {
		t.Fatal("child did not durably enqueue")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if child.Wait() == nil {
		t.Fatal("child was not killed")
	}
	var delivered atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/usage" {
			delivered.Add(1)
		}
	}))
	defer server.Close()
	restarted := &Runtime{Spool: directory, URL: server.URL, Client: server.Client(), Replica: "fixture"}
	if err = restarted.recoverSpool(); err != nil {
		t.Fatal(err)
	}
	restarted.flush()
	restarted.flush()
	files, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil || len(files) != 0 || delivered.Load() != 1 {
		t.Fatal("acknowledged event was lost or replayed after acknowledgement", err, delivered.Load())
	}
}
