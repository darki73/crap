// Package policy owns routing decisions independently of CLIProxy selectors.
package policy

import (
	"math"
	"sort"
	"strings"
	"time"
)

type Window struct {
	Label      string   `json:"label"`
	Used       *float64 `json:"used"`
	ResetAt    *int64   `json:"resetAt,omitempty"`
	ObservedAt *int64   `json:"observedAt,omitempty"`
	Source     string   `json:"source,omitempty"`
	Status     string   `json:"status,omitempty"`
}
type Candidate struct {
	Revision   string    `json:"revision,omitempty"`
	ID         string    `json:"id"`
	Provider   string    `json:"provider"`
	ObservedAt time.Time `json:"observedAt"`
	Windows    []Window  `json:"windows"`
	Error      bool      `json:"error"`
}
type Config struct {
	Version          int64   `json:"version"`
	Mode             string  `json:"mode"`
	MinimumRemaining float64 `json:"minimumRemaining"`
	FreshnessSeconds int     `json:"freshnessSeconds"`
	AffinitySeconds  int     `json:"affinitySeconds"`
}
type Decision struct {
	AccountID string `json:"accountId"`
	Reason    string `json:"reason"`
	Mode      string `json:"mode"`
	ResetAt   int64  `json:"resetAt,omitempty"`
}

// Choose retains a healthy binding; otherwise it picks the greatest minimum
// remaining allowance across applicable windows. Unknown data is ineligible.
// Stable ID ordering breaks ties. Headroom is not a token reservation.
func Choose(now time.Time, cfg Config, model, bound string, candidates []Candidate) Decision {
	type scored struct {
		id        string
		remaining float64
	}
	var eligible []scored
	for _, c := range candidates {
		if c.Error || c.ObservedAt.IsZero() || c.ObservedAt.After(now.Add(time.Minute)) {
			continue
		}
		remaining, count, valid := 100.0, 0, true
		for _, w := range c.Windows {
			label, modelName := strings.ToLower(w.Label), strings.ToLower(model)
			// Known model-specific windows apply only to that model family.
			if strings.Contains(label, "opus") && !strings.Contains(modelName, "opus") {
				continue
			}
			if strings.Contains(label, "sonnet") && !strings.Contains(modelName, "sonnet") {
				continue
			}
			if strings.Contains(label, "fable") && !strings.Contains(modelName, "fable") {
				continue
			}
			if strings.Contains(label, "code review") {
				continue
			}
			// Unknown scopes remain conservative rather than silently ignored.
			count++
			observed := c.ObservedAt
			if w.ObservedAt != nil {
				observed = time.UnixMilli(*w.ObservedAt)
			}
			// Bounded collection grace covers local scheduling and provider latency;
			// actual rejection/reset signals still take precedence.
			if observed.IsZero() || observed.After(now.Add(time.Minute)) || now.Sub(observed) > time.Duration(cfg.FreshnessSeconds+60)*time.Second || w.Status == "rejected" || w.Used == nil || math.IsNaN(*w.Used) || math.IsInf(*w.Used, 0) || *w.Used < 0 || (w.ResetAt != nil && *w.ResetAt <= now.UnixMilli()) {
				valid = false
				break
			}
			remaining = math.Min(remaining, 100-*w.Used)
		}
		if valid && count > 0 && remaining >= cfg.MinimumRemaining {
			if c.ID == bound {
				return Decision{AccountID: c.ID, Reason: "affinity retained", Mode: cfg.Mode}
			}
			eligible = append(eligible, scored{c.ID, remaining})
		}
	}
	if len(eligible) == 0 {
		return Decision{Reason: "no candidate has fresh quota and sufficient headroom", Mode: cfg.Mode}
	}
	sort.Slice(eligible, func(i, j int) bool {
		if eligible[i].remaining == eligible[j].remaining {
			return eligible[i].id < eligible[j].id
		}
		return eligible[i].remaining > eligible[j].remaining
	})
	reason := "greatest remaining headroom"
	if bound != "" {
		reason = "affinity failed eligibility; selected healthy account"
	}
	return Decision{AccountID: eligible[0].id, Reason: reason, Mode: cfg.Mode}
}
