package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCredentialImportPreservesIdentityAndDisabledState(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "account.json"), []byte(`{"type":"claude","disabled":true,"refresh_token":"example"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := readCredentials(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].ID != "account.json" || !entries[0].Disabled || entries[0].Metadata["refresh_token"] != "example" {
		t.Fatal("credential identity or metadata changed")
	}
}

func TestCredentialImportRejectsUnknownJSONBeforeWriting(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "unknown.json"), []byte(`{"unexpected":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readCredentials(dir); err == nil {
		t.Fatal("unknown credential accepted")
	}
}
