package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
)

// Model discovery is read-only. It passes the same authentication and readiness
// checks as inference, but creates no execution grant and contacts no provider.
func (s *StrictGate) models(w http.ResponseWriter, r *http.Request, clientKey string) {
	target := s.Gateway.Proxy.ResolveReference(&url.URL{Path: "/v1/models"})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		unavailable(w)
		return
	}
	// Do not relay caller-controlled headers, query parameters or management credentials.
	req.Header.Set("Authorization", "Bearer "+clientKey)
	resp, err := s.Gateway.Client.Do(req)
	if err != nil {
		unavailable(w)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	const limit = 8 << 20
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || resp.StatusCode != http.StatusOK || len(body) > limit || !json.Valid(body) {
		unavailable(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}
