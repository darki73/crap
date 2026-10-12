// The control-room migration helper uses CLIProxy's store implementation without
// changing the proxy. Secrets arrive on stdin and never appear in command arguments.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/store"
	auth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

type request struct {
	Action    string `json:"action"`
	DSN       string `json:"dsn"`
	Directory string `json:"directory"`
}
type result struct {
	Database    string `json:"database"`
	History     int64  `json:"history"`
	ProxySchema bool   `json:"proxySchema"`
	Credentials int    `json:"credentials"`
}

func main() {
	// Store errors can contain DSNs, paths or account names; only fixed errors
	// cross the process boundary. Detailed secrets must not reach bridge logs.
	log.SetOutput(io.Discard)
	var input request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 65536))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		os.Exit(1)
	}
	output, err := run(context.Background(), input)
	if err != nil {
		os.Exit(1)
	}
	if errEncode := json.NewEncoder(os.Stdout).Encode(output); errEncode != nil {
		os.Exit(1)
	}
}

func run(ctx context.Context, input request) (result, error) {
	var output result
	if input.Action != "check" && input.Action != "import" && input.Action != "verify" {
		return output, errors.New("invalid action")
	}
	db, errOpen := sql.Open("pgx", input.DSN)
	if errOpen != nil {
		return output, errOpen
	}
	defer func() {
		if errClose := db.Close(); errClose != nil {
			log.Error("Database close failed")
		}
	}()
	if errQuery := db.QueryRowContext(ctx, "SELECT current_database()").Scan(&output.Database); errQuery != nil {
		return output, errQuery
	}
	if errQuery := db.QueryRowContext(ctx, "SELECT count(*) FROM affinity_router.usage_events").Scan(&output.History); errQuery != nil {
		return output, errQuery
	}
	if errQuery := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='cliproxy')").Scan(&output.ProxySchema); errQuery != nil {
		return output, errQuery
	}
	if input.Action == "check" {
		return output, nil
	}
	if input.Action == "verify" {
		if errQuery := db.QueryRowContext(ctx, "SELECT count(*) FROM cliproxy.auth_store").Scan(&output.Credentials); errQuery != nil {
			return output, errQuery
		}
		return output, nil
	}
	// Never merge a migration into an existing credential store.
	if output.ProxySchema {
		return output, errors.New("destination already exists")
	}
	entries, errRead := readCredentials(filepath.Join(input.Directory, "auths"))
	if errRead != nil {
		return output, errRead
	}
	configPath := filepath.Join(input.Directory, "config.yaml")
	configInfo, errStat := os.Stat(configPath)
	if errStat != nil || configInfo.Size() == 0 {
		return output, errors.New("configuration backup missing")
	}
	pg, errStore := store.NewPostgresStore(ctx, store.PostgresStoreConfig{DSN: input.DSN, Schema: "cliproxy", SpoolDir: filepath.Join(input.Directory, "spool")})
	if errStore != nil {
		return output, errStore
	}
	defer func() {
		if errClose := pg.Close(); errClose != nil {
			log.Error("Token store close failed")
		}
	}()
	if errBootstrap := pg.Bootstrap(ctx, configPath); errBootstrap != nil {
		return output, errBootstrap
	}
	for _, entry := range entries {
		if _, errSave := pg.Save(auth.WithAuthCreationIntent(ctx), entry); errSave != nil {
			return output, errSave
		}
	}
	saved, errList := pg.List(ctx)
	if errList != nil || len(saved) != len(entries) {
		return output, errors.New("credential verification failed")
	}
	output.Credentials = len(saved)
	output.ProxySchema = true
	return output, nil
}

func readCredentials(dir string) ([]*auth.Auth, error) {
	entries := make([]*auth.Auth, 0)
	errWalk := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("credential symlinks unsupported")
		}
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
			return nil
		}
		raw, errRead := os.ReadFile(path)
		if errRead != nil {
			return errRead
		}
		var metadata map[string]any
		if errDecode := json.Unmarshal(raw, &metadata); errDecode != nil {
			return errDecode
		}
		provider, ok := metadata["type"].(string)
		if !ok || provider == "" {
			return errors.New("unknown credential format")
		}
		name, errRel := filepath.Rel(dir, path)
		if errRel != nil {
			return errRel
		}
		name = filepath.ToSlash(name)
		disabled, _ := metadata["disabled"].(bool)
		entries = append(entries, &auth.Auth{ID: name, FileName: name, Provider: provider, Metadata: metadata, Disabled: disabled})
		return nil
	})
	return entries, errWalk
}
