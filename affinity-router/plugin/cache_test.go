package plugin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCacheSplitValidation(t *testing.T) {
	for _, tc := range []struct {
		name, usage string
		valid       bool
	}{
		{"mixed", `{"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":7}}`, true},
		{"zero", `{"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}`, true},
		{"missing", `{"cache_creation_input_tokens":10}`, false},
		{"partial", `{"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":10}}`, false},
		{"mismatch", `{"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":8}}`, false},
		{"negative", `{"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":-1,"ephemeral_1h_input_tokens":11}}`, false},
		{"overflow", `{"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":9223372036854775807,"ephemeral_1h_input_tokens":1}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, body := range []string{`{"type":"message","usage":` + tc.usage + `}`, `{"type":"message_start","message":{"usage":` + tc.usage + `}}`} {
				if got := parseCacheUsage([]byte(body)); (got != nil) != tc.valid {
					t.Fatalf("valid=%v, got %v", tc.valid, got)
				}
			}
		})
	}
}

func TestCacheObserversAreReadOnlyAndSanitized(t *testing.T) {
	r := &Runtime{Replica: "replica", Spool: t.TempDir(), Key: []byte(strings.Repeat("k", 32))}
	body := `{"type":"message","content":[{"text":"private answer"}],"usage":{"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":7}}}`
	headers := http.Header{"Request-Id": []string{"private-upstream-id"}, "Set-Cookie": []string{"secret-cookie"}}
	for _, method := range []string{"response.intercept_after", "response.intercept_stream_chunk"} {
		wire := body
		if method == "response.intercept_stream_chunk" {
			wire = "event: message_start\ndata: " + strings.Replace(body, `"type":"message"`, `"type":"message_delta"`, 1) + "\n\n"
		}
		raw, _ := json.Marshal(cacheResponse{SourceFormat: "claude", ResponseHeaders: headers, Body: []byte(wire)})
		result, err := r.Handle(method, raw)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(result)
		if string(encoded) != "{}" {
			t.Fatal("observer modified response")
		}
	}
	files, _ := filepath.Glob(filepath.Join(r.Spool, "*.json"))
	if len(files) != 2 {
		t.Fatal("missing observations")
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		for _, secret := range []string{"private answer", "private-upstream-id", "secret-cookie"} {
			if strings.Contains(string(raw), secret) {
				t.Fatal("persisted private response data")
			}
		}
	}
	u := Usage{Provider: "claude", ExecutorType: "ClaudeExecutor", ResponseHeaders: headers}
	if e := r.Usage(u); e.ResponseRef == nil || *e.ResponseRef != r.responseRef(headers) {
		t.Fatal("usage and response do not correlate")
	}
	if r.responseRef(nil) != "" {
		t.Fatal("invented missing request ID")
	}
}
