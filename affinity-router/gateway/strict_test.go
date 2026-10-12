package gateway

import (
	"net/http"
	"testing"
)

func TestClaudeFamilyIdentity(t *testing.T) {
	for _, tc := range []struct{ body, session, parent string }{
		{`{"metadata":{"user_id":"user_abc_account_xyz_session_1234"}}`, "1234", ""},
		{`{"metadata":{"user_id":"{\"session_id\":\"child\",\"parent_session_id\":\"parent\",\"agent_id\":\"worker\"}"}}`, "child", "parent"},
		{`{"session_id":"s","metadata":{"parent_session_id":"p"}}`, "s", "p"},
		{`{"messages":[{"role":"user","content":"do not infer identity from me"}]}`, "", ""},
	} {
		s, p := Session(http.Header{}, []byte(tc.body))
		if s != tc.session || p != tc.parent {
			t.Fatalf("got %q/%q", s, p)
		}
	}
	h := http.Header{"X-Claude-Code-Session-Id": []string{"header"}, "X-Parent-Session-Id": []string{"parent"}}
	s, p := Session(h, []byte(`{"session_id":"body"}`))
	if s != "header" || p != "parent" {
		t.Fatal("explicit header identity lost")
	}
}
