package plugin

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"

	"cliproxy-affinity-router/storage"
)

// Only the upstream request ID is retained, HMACed with a replica namespace.
// Missing IDs are not replaced with a guessed trace/model/time match.
func (r *Runtime) responseRef(headers http.Header) string {
	id := headers.Get("Request-Id")
	if id == "" {
		return ""
	}
	return r.ref("upstream-response", r.Replica+"/"+id)
}

type cacheResponse struct {
	SourceFormat    string
	ResponseHeaders http.Header
	Body            []byte
}

func (r *Runtime) observeCache(req cacheResponse) error {
	ref := r.responseRef(req.ResponseHeaders)
	if req.SourceFormat != "claude" || ref == "" {
		return nil
	}
	// Stream interceptors receive complete translated SSE events. Never retain
	// content or raw headers in the spool; only a validated usage object leaves here.
	bodies := [][]byte{req.Body}
	if !json.Valid(req.Body) {
		bodies = nil
		for _, line := range bytes.Split(req.Body, []byte("\n")) {
			if bytes.HasPrefix(line, []byte("data:")) {
				bodies = append(bodies, bytes.TrimSpace(line[5:]))
			}
		}
	}
	for _, body := range bodies {
		if observation := parseCacheUsage(body); observation != nil {
			observation.ResponseRef = ref
			if err := r.enqueue("/cache-observations", observation); err != nil {
				return err
			}
		}
	}
	return nil
}

func parseCacheUsage(body []byte) *storage.CacheObservation {
	type usage struct {
		Total    *int64 `json:"cache_creation_input_tokens"`
		Creation struct {
			Five *int64 `json:"ephemeral_5m_input_tokens"`
			Hour *int64 `json:"ephemeral_1h_input_tokens"`
		} `json:"cache_creation"`
	}
	var payload struct {
		Type    string `json:"type"`
		Usage   usage  `json:"usage"`
		Message struct {
			Usage usage `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return nil
	}
	u := payload.Usage
	switch payload.Type {
	case "message_start":
		u = payload.Message.Usage
	case "message", "message_delta":
	default:
		return nil
	}
	if u.Total == nil || u.Creation.Five == nil || u.Creation.Hour == nil {
		return nil
	}
	five, hour := *u.Creation.Five, *u.Creation.Hour
	if five < 0 || hour < 0 || five > math.MaxInt64-hour || five+hour != *u.Total {
		return nil
	}
	return &storage.CacheObservation{CacheWrite: *u.Total, CacheWrite5m: five, CacheWrite1h: hour}
}
