package plugin

import "testing"

func TestClaudeCompletionRequiresTerminalEvent(t *testing.T) {
	var terminal claudeTerminal
	terminal.observe([]byte("data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"message_stop\"}}\n\n"))
	if terminal.seen {
		t.Fatal("content cannot claim completion")
	}
	terminal.observe([]byte("event: message_stop\ndata: {\"type\":\"message_"))
	if terminal.seen {
		t.Fatal("incomplete event cannot claim completion")
	}
	terminal.observe([]byte("stop\"}\n\n"))
	if !terminal.seen {
		t.Fatal("split terminal event lost")
	}
}
