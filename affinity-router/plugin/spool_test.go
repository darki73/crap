package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSpoolCapacityStopsAdmissionButPreservesCompletions(t *testing.T) {
	r := &Runtime{Spool: t.TempDir(), SpoolMaxFiles: 1}
	if err := r.spoolHealth(); err != nil {
		t.Fatal(err)
	}
	if err := r.enqueue("/journal", map[string]string{"ID": "first"}); err != nil {
		t.Fatal(err)
	}
	if err := r.spoolHealth(); err == nil {
		t.Fatal("full spool admitted work")
	}
	if err := r.enqueue("/journal", map[string]string{"ID": "completion"}); err != nil {
		t.Fatal("lost already-admitted completion", err)
	}
	files, _ := os.ReadDir(r.Spool)
	if len(files) != 2 {
		t.Fatal("completion missing")
	}
	r.SpoolMaxFiles = 100
	r.SpoolMaxBytes = 1
	if err := r.spoolHealth(); err == nil {
		t.Fatal("byte threshold ignored")
	}
}

func TestRecoverInterruptedSpoolWrites(t *testing.T) {
	r := &Runtime{Spool: t.TempDir()}
	for name, body := range map[string]string{"pending-valid.tmp": `{"Path":"/journal","Body":{"ID":"fixture"}}`, "pending-partial.tmp": `{"Path":`, "probe-leftover": ""} {
		if err := os.WriteFile(filepath.Join(r.Spool, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.recoverSpool(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pending-valid.json", "pending-partial.tmp.rejected"} {
		if _, err := os.Stat(filepath.Join(r.Spool, name)); err != nil {
			t.Fatal("lost recovered record", err)
		}
	}
	if err := r.spoolHealth(); err == nil {
		t.Fatal("rejected data silently ignored")
	}
	if err := r.recoverSpool(); err != nil {
		t.Fatal("recovery not idempotent", err)
	}
}

func TestUnavailableSpoolRejectsBeforeControlCall(t *testing.T) {
	r := &Runtime{Spool: filepath.Join(t.TempDir(), "missing")}
	response, err := r.Handle("request.intercept_before", []byte(`{"RequestID":"fixture"}`))
	if err != nil {
		t.Fatal(err)
	}
	result := response.(map[string]any)
	if result["Terminate"] != true || result["StatusCode"] != 503 {
		t.Fatal("unavailable spool admitted work")
	}
}
