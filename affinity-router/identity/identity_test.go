package identity

import (
	"strings"
	"testing"
)

func TestReferenceSeparation(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	base, err := Reference(key, "tenant-a", "session", "private@example.com")
	if err != nil || strings.Contains(base, "private") {
		t.Fatalf("unexpected identity result: %q %v", base, err)
	}
	repeated, _ := Reference(key, "tenant-a", "session", "private@example.com")
	if base != repeated {
		t.Fatal("references must be stable across replicas")
	}
	for _, parts := range [][3]string{{"tenant-b", "session", "private@example.com"}, {"tenant-a", "account", "private@example.com"}, {"tenant-a", "session", "another"}} {
		other, errOther := Reference(key, parts[0], parts[1], parts[2])
		if errOther != nil || other == base {
			t.Fatal("identities crossed a namespace boundary")
		}
	}
	if _, errShort := Reference([]byte("short"), "t", "session", "s"); errShort == nil {
		t.Fatal("accepted weak key")
	}
}
