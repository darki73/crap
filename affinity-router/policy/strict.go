package policy

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// ChooseStrict keeps affinity while every applicable window meets the reserve. Observation
// age and collection errors never erase a usable observation. A reset permits a
// new real request to learn the window; it does not fabricate fresh percentages.
func ChooseStrict(now time.Time, minimumRemaining float64, model, bound, filling string, candidates []Candidate) Decision {
	if math.IsNaN(minimumRemaining) || math.IsInf(minimumRemaining, 0) || minimumRemaining < 0 || minimumRemaining > 100 {
		return Decision{Reason: "invalid quota reserve", Mode: "live"}
	}
	type score struct {
		id            string
		weekly, short float64
		known         bool
	}
	var eligible []score
	var earliest int64
	for _, c := range candidates {
		s := score{id: c.ID, weekly: 101, short: 101}
		blocked := false
		var reset int64
		unknownReset := false
		for _, w := range c.Windows {
			label := strings.ToLower(w.Label)
			if !applicable(label, strings.ToLower(model)) {
				continue
			}
			if w.ResetAt != nil && *w.ResetAt <= now.UnixMilli() {
				continue
			}
			if w.Status == "rejected" || (w.Used != nil && (*w.Used >= 100 || 100-*w.Used < minimumRemaining)) {
				blocked = true
				if w.ResetAt == nil {
					unknownReset = true
				} else if *w.ResetAt > reset {
					reset = *w.ResetAt
				}
			}
			if w.Used == nil || math.IsNaN(*w.Used) || math.IsInf(*w.Used, 0) || *w.Used < 0 {
				continue
			}
			s.known = true
			remaining := math.Max(0, 100-*w.Used)
			if strings.Contains(label, "week") || strings.Contains(label, "7-day") {
				s.weekly = math.Min(s.weekly, remaining)
			} else if strings.Contains(label, "5") {
				s.short = math.Min(s.short, remaining)
			}
		}
		if blocked {
			if !unknownReset && reset > 0 && (earliest == 0 || reset < earliest) {
				earliest = reset
			}
			continue
		}
		if c.ID == bound {
			return Decision{AccountID: c.ID, Reason: "conversation family retained", Mode: "live"}
		}
		eligible = append(eligible, s)
	}
	if len(eligible) == 0 {
		return Decision{Reason: fmt.Sprintf("no subscription account meets the %g%% quota reserve", minimumRemaining), Mode: "live", ResetAt: earliest}
	}
	for _, c := range eligible {
		if c.id == filling {
			return Decision{AccountID: c.id, Reason: "continue filling current account", Mode: "live"}
		}
	}
	sort.Slice(eligible, func(i, j int) bool {
		a, b := eligible[i], eligible[j]
		if a.known != b.known {
			return a.known
		}
		if a.weekly != b.weekly {
			return a.weekly < b.weekly
		}
		if a.short != b.short {
			return a.short < b.short
		}
		return a.id < b.id
	})
	reason := "least remaining weekly allowance, then five-hour allowance"
	if !eligible[0].known {
		reason = "learn unknown quota from a real request"
	}
	return Decision{AccountID: eligible[0].id, Reason: reason, Mode: "live"}
}

func applicable(label, model string) bool {
	for _, family := range []string{"opus", "sonnet", "fable", "haiku"} {
		if strings.Contains(label, family) && !strings.Contains(model, family) {
			return false
		}
	}
	return !strings.Contains(label, "code review")
}
