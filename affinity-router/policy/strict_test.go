package policy

import (
	"testing"
	"time"
)

func TestStrictExhaustBeforeSwitch(t *testing.T) {
	now := time.Unix(100000, 0)
	candidate := func(id string, weekly, short float64) Candidate {
		return Candidate{ID: id, ObservedAt: now.Add(-24 * time.Hour), Error: true, Windows: []Window{{Label: "Weekly window", Used: &weekly}, {Label: "5-hour window", Used: &short}}}
	}
	a, b, c := candidate("a", 80, 10), candidate("b", 40, 30), candidate("c", 0, 0)
	for _, tc := range []struct {
		name, bound, filling, want string
		list                       []Candidate
	}{
		{"least weekly first", "", "", "a", []Candidate{c, b, a}},
		{"stale bound retained", "b", "a", "b", []Candidate{a, b, c}},
		{"keep filling", "", "b", "b", []Candidate{a, b, c}},
		{"bound below reserve switches", "a", "", "b", []Candidate{candidate("a", 99.9, 99.9), b}},
		{"weekly exhausted", "a", "", "b", []Candidate{candidate("a", 100, 0), b}},
		{"short exhausted", "a", "", "b", []Candidate{candidate("a", 80, 100), b}},
		{"unknown allowed", "", "", "unknown", []Candidate{{ID: "unknown"}}},
		{"known before unknown", "", "", "a", []Candidate{{ID: "unknown"}, a}},
		{"unknown pinned retained", "unknown", "a", "unknown", []Candidate{{ID: "unknown"}, a}},
		{"no account", "", "", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if d := ChooseStrict(now, 5, "claude-sonnet", tc.bound, tc.filling, tc.list); d.AccountID != tc.want {
				t.Fatalf("got %+v want %s", d, tc.want)
			}
		})
	}
	short := now.Add(time.Hour).UnixMilli()
	weekly := now.Add(24 * time.Hour).UnixMilli()
	full := 100.0
	a.Windows = []Window{{Label: "5-hour window", Used: &full, ResetAt: &short}, {Label: "Weekly window", Used: &full, ResetAt: &weekly}}
	if d := ChooseStrict(now, 5, "claude-sonnet", "a", "", []Candidate{a}); d.ResetAt != weekly {
		t.Fatal("must wait for both windows", d)
	}
	if d := ChooseStrict(now.Add(25*time.Hour), 5, "claude-sonnet", "a", "", []Candidate{a}); d.AccountID != "a" {
		t.Fatal("reset should allow learning", d)
	}
}

func TestStrictReserveAppliesToEveryAssignmentAndApplicableWindow(t *testing.T) {
	now := time.Unix(100000, 0)
	used := func(v float64) *float64 { return &v }
	for _, label := range []string{"5-hour window", "Weekly window", "Weekly · Opus"} {
		for _, position := range []string{"new", "bound", "filling"} {
			for _, usage := range []float64{94.9, 95, 95.1, 97, 100} {
				low := Candidate{ID: "a", ObservedAt: now.Add(-24 * time.Hour), Windows: []Window{{Label: label, Used: used(usage)}}}
				other := Candidate{ID: "b", Windows: []Window{{Label: "Weekly window", Used: used(20)}}}
				bound, filling := "", ""
				if position == "bound" {
					bound = "a"
				}
				if position == "filling" {
					filling = "a"
				}
				d := ChooseStrict(now, 5, "claude-opus", bound, filling, []Candidate{low, other})
				want := "a"
				if usage > 95 {
					want = "b"
				}
				// With only a short/model-specific window, the fallback weekly sort can
				// legitimately prefer b for a new assignment; only assert the reserve there.
				if usage <= 95 && position == "new" && label == "5-hour window" {
					continue
				}
				if d.AccountID != want {
					t.Fatalf("%s %s used=%v got=%+v want=%s", label, position, usage, d, want)
				}
			}
		}
	}
	low := Candidate{ID: "a", Windows: []Window{{Label: "Weekly · Fable", Used: used(99)}, {Label: "Weekly window", Used: used(80)}}}
	if d := ChooseStrict(now, 5, "claude-sonnet", "a", "", []Candidate{low}); d.AccountID != "a" {
		t.Fatal("unrelated model window blocked request", d)
	}
	if d := ChooseStrict(now, 5, "claude-fable", "a", "", []Candidate{low}); d.AccountID != "" {
		t.Fatal("matching model window bypassed reserve", d)
	}
	low.Windows = []Window{{Label: "Weekly window", Used: used(97)}}
	if d := ChooseStrict(now, 0, "claude-opus", "a", "", []Candidate{low}); d.AccountID != "a" {
		t.Fatal("zero reserve should allow unexhausted account", d)
	}
	low.Windows[0].Used = used(100)
	if d := ChooseStrict(now, 0, "claude-opus", "a", "", []Candidate{low}); d.AccountID != "" {
		t.Fatal("zero reserve allowed exhausted account", d)
	}
	short, weekly := now.Add(time.Hour).UnixMilli(), now.Add(24*time.Hour).UnixMilli()
	low.Windows = []Window{{Label: "5-hour window", Used: used(97), ResetAt: &short}, {Label: "Weekly window", Used: used(97), ResetAt: &weekly}}
	if d := ChooseStrict(now, 5, "claude-opus", "a", "", []Candidate{low}); d.ResetAt != weekly || d.AccountID != "" {
		t.Fatal("must wait for both below-reserve windows", d)
	}
	if d := ChooseStrict(now.Add(2*time.Hour), 5, "claude-opus", "a", "", []Candidate{low}); d.AccountID != "" {
		t.Fatal("short reset must not override weekly reserve", d)
	}
	if d := ChooseStrict(now.Add(25*time.Hour), 5, "claude-opus", "a", "", []Candidate{low}); d.AccountID != "a" {
		t.Fatal("resets should allow learning", d)
	}
}
