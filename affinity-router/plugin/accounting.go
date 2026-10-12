package plugin

import (
	"cliproxy-affinity-router/storage"
	"math"
)

// normalizeKnownUsage implements the verified native executor hook contract in
// the pinned checkout. Claude input excludes caches; Codex input includes caches;
// both output totals include reasoning. Positive input/output and an exact total
// reconciliation are required because the hook loses field-presence information.
// Keep fixture tests aligned with upstream usage_helpers.go during upgrades.
func normalizeKnownUsage(u Usage, e *storage.UsageEvent) {
	e.AuthType = u.AuthType
	e.ServiceTier = u.ResponseServiceTier
	if e.ServiceTier == "" {
		e.ServiceTier = u.ServiceTier
	}
	e.AccountingSource = "legacy_hook_unclassified"
	d := u.Detail
	if d.InputTokens <= 0 || d.OutputTokens <= 0 || d.TotalTokens <= 0 || d.ReasoningTokens < 0 || d.CacheReadTokens < 0 || d.CacheCreationTokens < 0 || d.ReasoningTokens > d.OutputTokens {
		return
	}
	input, read, write, output, reason := d.InputTokens, d.CacheReadTokens, d.CacheCreationTokens, d.OutputTokens-d.ReasoningTokens, d.ReasoningTokens
	switch {
	case u.Provider == "claude" && u.ExecutorType == "ClaudeExecutor":
	case u.Provider == "codex" && (u.ExecutorType == "CodexExecutor" || u.ExecutorType == "CodexWebsocketsExecutor" || u.ExecutorType == "CodexAutoExecutor"):
		if read > input || write > input-read {
			return
		}
		input -= read + write
	default:
		return
	}
	sum := int64(0)
	for _, v := range []int64{input, read, write, output, reason} {
		if v > math.MaxInt64-sum {
			return
		}
		sum += v
	}
	if sum != d.TotalTokens {
		return
	}
	e.InputUncached = &input
	e.CacheRead = &read
	e.CacheWrite = &write
	e.OutputNonReasoning = &output
	e.OutputReasoning = &reason
	total := d.TotalTokens
	e.ReportedTotal = &total
	e.Quality = "complete"
	e.AccountingSource = "native_hook_reconciled_v1"
}
