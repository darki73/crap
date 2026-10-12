package control

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMaintenancePersistsAndGuardsWrites(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "maintenance.lock")
	s := &Server{Token: "test-token", MaintenanceFile: marker}
	call := func(server *Server, method, path, body, token string) int {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, req)
		return response.Code
	}
	if got := call(s, "POST", "/maintenance", `{"paused":true}`, "wrong"); got != 401 {
		t.Fatalf("unauthorized pause: %d", got)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("unauthorized request created marker")
	}
	if got := call(s, "POST", "/maintenance", `{"paused":true}`, s.Token); got != 200 {
		t.Fatalf("pause: %d", got)
	}
	// A newly constructed server must remain paused without in-memory state.
	restarted := &Server{Token: s.Token, MaintenanceFile: marker}
	if got := call(restarted, "POST", "/usage", `{}`, s.Token); got != 503 {
		t.Fatalf("write not blocked: %d", got)
	}
	if got := call(restarted, "GET", "/state", ``, s.Token); got != 503 {
		t.Fatalf("state not blocked: %d", got)
	}
	if got := call(restarted, "POST", "/maintenance", `{"paused":false}`, s.Token); got != 200 {
		t.Fatalf("resume: %d", got)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("marker not removed")
	}
}
