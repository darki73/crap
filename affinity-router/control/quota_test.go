package control

import (
	"cliproxy-affinity-router/policy"
	"testing"
	"time"
)

func TestMergeQuotaWindows(t *testing.T) {
	now := time.Now()
	newer := now.Add(time.Minute).UnixMilli()
	a, b := 10.0, 20.0
	old := []policy.Window{{Label: "weekly", Used: &a, ObservedAt: &newer}, {Label: "short", Used: &a}}
	next := []policy.Window{{Label: "weekly", Used: &b}, {Label: "short", Used: &b}}
	got := mergeQuotaWindows(old, now.Add(-time.Hour), next, now)
	if *got[0].Used != a || *got[0].ObservedAt != newer {
		t.Fatal("older snapshot overwrote fresh window")
	}
	if *got[1].Used != b || *got[1].ObservedAt != now.UnixMilli() {
		t.Fatal("window did not advance independently")
	}
	got = mergeQuotaWindows(got, now, []policy.Window{{Label: "short", Used: &a}}, now.Add(2*time.Minute))
	if *got[0].ObservedAt != newer {
		t.Fatal("partial update refreshed omitted window")
	}
}
