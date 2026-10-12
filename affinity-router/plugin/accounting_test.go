package plugin

import "testing"

func TestNativeUsageContract(t *testing.T) {
	u := Usage{Provider: "claude", ExecutorType: "ClaudeExecutor"}
	u.Detail.InputTokens = 10
	u.Detail.CacheReadTokens = 30
	u.Detail.CacheCreationTokens = 20
	u.Detail.OutputTokens = 15
	u.Detail.ReasoningTokens = 5
	u.Detail.TotalTokens = 75
	r := &Runtime{Key: make([]byte, 32)}
	e := r.Usage(u)
	if e.Quality != "complete" || *e.InputUncached != 10 || *e.OutputNonReasoning != 10 || *e.OutputReasoning != 5 {
		t.Fatal("Claude reasoning/cache double counted", e)
	}
	u.Provider = "codex"
	u.ExecutorType = "CodexExecutor"
	u.Detail.InputTokens = 60
	e = r.Usage(u)
	if e.Quality != "complete" || *e.InputUncached != 10 || *e.ReportedTotal != 75 {
		t.Fatal("Codex cache double counted", e)
	}
	u.Detail.TotalTokens = 90
	e = r.Usage(u)
	if e.Quality == "complete" {
		t.Fatal("accepted inconsistent accounting")
	}
	u.Detail.TotalTokens = 75
	u.ExecutorType = "CustomExecutor"
	e = r.Usage(u)
	if e.Quality == "complete" {
		t.Fatal("guessed custom executor semantics")
	}
}
