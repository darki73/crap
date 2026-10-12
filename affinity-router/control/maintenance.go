package control

import (
	"net/http"
	"os"
)

// The exclusive lock drains existing handlers before acknowledging a pause.
// The marker survives a process restart. Unknown filesystem state fails closed.
func (s *Server) handleMaintenance(w http.ResponseWriter, r *http.Request) {
	s.maintenance.Lock()
	defer s.maintenance.Unlock()
	if s.MaintenanceFile == "" {
		respond(w, 503, map[string]string{"error": "maintenance persistence is not configured"})
		return
	}
	if r.Method == http.MethodPost {
		var input struct {
			Paused bool `json:"paused"`
		}
		if err := decode(w, r, &input); err != nil {
			respond(w, 400, map[string]string{"error": "invalid maintenance request"})
			return
		}
		var err error
		if input.Paused {
			err = os.WriteFile(s.MaintenanceFile, []byte("Database migration: resume only when the destination is stopped.\n"), 0600)
		} else {
			err = os.Remove(s.MaintenanceFile)
			if os.IsNotExist(err) {
				err = nil
			}
		}
		if err != nil {
			respond(w, 500, map[string]string{"error": "cannot persist maintenance state"})
			return
		}
	} else if r.Method != http.MethodGet {
		respond(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	_, err := os.Stat(s.MaintenanceFile)
	respond(w, 200, map[string]bool{"paused": !os.IsNotExist(err)})
}
