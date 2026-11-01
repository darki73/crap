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

func TestRetiredSessionWindowKeepsObservationOrdering(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	full := 100.0
	old := []policy.Window{{Label: "5-hour window", Used: &full}}
	retired := []policy.Window{{Label: "5-hour window", Source: "poll", Status: "not_applicable"}}
	got := mergeQuotaWindows(old, now.Add(-time.Minute), retired, now)
	if got[0].Used != nil || got[0].Status != "not_applicable" {
		t.Fatal("retired limit survived")
	}
	got = mergeQuotaWindows(got, now, old, now.Add(-time.Second))
	if got[0].Status != "not_applicable" {
		t.Fatal("stale response resurrected the retired window")
	}
	got = mergeQuotaWindows(got, now, old, now.Add(time.Second))
	if got[0].Used == nil || *got[0].Used != full {
		t.Fatal("new provider limit was ignored")
	}
}
