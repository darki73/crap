package policy

import (
	"testing"
	"time"
)

func TestAffinityAndQuota(t *testing.T) {
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	cfg := Config{Mode: "shadow", MinimumRemaining: 5, FreshnessSeconds: 300}
	makeCandidate := func(id string, used float64) Candidate {
		return Candidate{ID: id, ObservedAt: now, Windows: []Window{{Label: "5-hour window", Used: &used}}}
	}
	a, b := makeCandidate("a", 70), makeCandidate("b", 10)
	if d := Choose(now, cfg, "claude-sonnet", "a", []Candidate{a, b}); d.AccountID != "a" {
		t.Fatal("lost healthy affinity", d)
	}
	a = makeCandidate("a", 99)
	if d := Choose(now, cfg, "claude-sonnet", "a", []Candidate{a, b}); d.AccountID != "b" {
		t.Fatal("failed quota failover", d)
	}
	b.ObservedAt = now.Add(-361 * time.Second)
	if d := Choose(now, cfg, "claude-sonnet", "a", []Candidate{a, b}); d.AccountID != "" {
		t.Fatal("routed on stale data", d)
	}
	b = makeCandidate("b", 0)
	reset := now.UnixMilli()
	b.Windows[0].ResetAt = &reset
	if d := Choose(now, cfg, "m", "", []Candidate{b}); d.AccountID != "" {
		t.Fatal("assumed reset replenished quota", d)
	}
	b = makeCandidate("b", 0)
	unknown := Window{Label: "Weekly window"}
	b.Windows = append(b.Windows, unknown)
	if d := Choose(now, cfg, "m", "", []Candidate{b}); d.AccountID != "" {
		t.Fatal("ignored unknown weekly window", d)
	}
	b = makeCandidate("b", 10)
	full := float64(100)
	b.Windows = append(b.Windows, Window{Label: "Weekly · Opus", Used: &full})
	if d := Choose(now, cfg, "claude-sonnet", "", []Candidate{b}); d.AccountID != "b" {
		t.Fatal("misapplied scoped window", d)
	}
	if d := Choose(now, cfg, "claude-opus", "", []Candidate{b}); d.AccountID != "" {
		t.Fatal("ignored scoped window", d)
	}
}

func TestWindowFreshnessAndCollectionGrace(t *testing.T) {
	now := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	cfg := Config{Mode: "live", MinimumRemaining: 5, FreshnessSeconds: 300}
	used := 1.0
	old, fresh := now.Add(-400*time.Second).UnixMilli(), now.UnixMilli()
	c := Candidate{ID: "a", ObservedAt: now, Windows: []Window{{Label: "5-hour window", Used: &used, ObservedAt: &fresh}, {Label: "Weekly window", Used: &used, ObservedAt: &old}}}
	if d := Choose(now, cfg, "claude-opus", "a", []Candidate{c}); d.AccountID != "" {
		t.Fatal("fresh short window hid stale weekly data")
	}
	grace := now.Add(-330 * time.Second).UnixMilli()
	c.Windows[1].ObservedAt = &grace
	if d := Choose(now, cfg, "claude-opus", "a", []Candidate{c}); d.AccountID != "a" {
		t.Fatal("lost affinity during bounded collection grace")
	}
	c.Windows = append(c.Windows, Window{Label: "Weekly · Fable", Used: &used, ObservedAt: &old})
	if d := Choose(now, cfg, "claude-opus", "a", []Candidate{c}); d.AccountID != "a" {
		t.Fatal("unrelated Fable limit blocked Opus")
	}
	if d := Choose(now, cfg, "claude-fable", "a", []Candidate{c}); d.AccountID != "" {
		t.Fatal("ignored stale Fable window")
	}
	c.Windows[0].Status = "rejected"
	if d := Choose(now, cfg, "claude-opus", "a", []Candidate{c}); d.AccountID != "" {
		t.Fatal("grace overrode explicit rejection")
	}
}
