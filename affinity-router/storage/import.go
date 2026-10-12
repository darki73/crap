package storage

import (
	"context"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5/pgxpool"
	"gopkg.in/yaml.v3"
)

// PrepareImport changes deployment paths once, preserving provider credentials,
// client keys and the management secret. The restored owner must remain stopped.
func PrepareImport(ctx context.Context, pool *pgxpool.Pool, id string) error {
	if !regexp.MustCompile(`^[a-f0-9]{12}$`).MatchString(id) {
		return fmt.Errorf("invalid import identity")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(702361880196)"); err != nil {
		return err
	}
	var done bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM cliproxy.config_store WHERE id=$1)", "crap-import-"+id).Scan(&done); err != nil {
		return err
	}
	if done {
		return tx.Commit(ctx)
	}
	var raw string
	if err = tx.QueryRow(ctx, "SELECT content FROM cliproxy.config_store WHERE id='config' FOR UPDATE").Scan(&raw); err != nil {
		return err
	}
	var cfg map[string]any
	if err = yaml.Unmarshal([]byte(raw), &cfg); err != nil {
		return fmt.Errorf("invalid imported configuration")
	}
	if cfg["config-version"] != 8 {
		return fmt.Errorf("import requires configuration version 8")
	}
	section := func(name string) map[string]any {
		v, ok := cfg[name].(map[string]any)
		if !ok {
			v = map[string]any{}
			cfg[name] = v
		}
		return v
	}
	server := section("server")
	server["host"] = "0.0.0.0"
	server["port"] = 8317
	management := section("management")
	management["allow-remote"] = true
	management["disable-control-panel"] = true
	plugins := section("plugins")
	plugins["enabled"] = true
	plugins["dir"] = "/CLIProxyAPI/plugins"
	configs, ok := plugins["configs"].(map[string]any)
	if !ok {
		configs = map[string]any{}
		plugins["configs"] = configs
	}
	configs["affinity-router"] = map[string]any{"enabled": true, "priority": 100}
	encoded, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE cliproxy.config_store SET content=$1,updated_at=now() WHERE id='config'", string(encoded)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO cliproxy.config_store(id,content) VALUES($1,'deployment paths adapted')", "crap-import-"+id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
