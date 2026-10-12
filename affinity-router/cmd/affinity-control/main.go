package main

import (
	"cliproxy-affinity-router/control"
	"cliproxy-affinity-router/storage"
	"context"
	"encoding/hex"
	"github.com/jackc/pgx/v5/pgxpool"
	log "github.com/sirupsen/logrus"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	if err := run(); err != nil {
		log.Error("Affinity control service stopped: check database, schema and environment configuration")
		os.Exit(1)
	}
}
func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	key, err := hex.DecodeString(os.Getenv("AFFINITY_ID_KEY"))
	if err != nil || len(key) < 32 || len(os.Getenv("AFFINITY_CONTROL_TOKEN")) < 32 {
		return os.ErrInvalid
	}
	pool, err := pgxpool.New(ctx, os.Getenv("AFFINITY_DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		return err
	}
	if err = storage.VerifySchema(ctx, pool); err != nil {
		return err
	}
	addr := os.Getenv("AFFINITY_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:8318"
	}
	api := &control.Server{Pool: pool, Token: os.Getenv("AFFINITY_CONTROL_TOKEN"), IdentityKey: key, Strict: os.Getenv("CRAP_STRICT_ROUTING") == "1"}
	api.MaintenanceFile = os.Getenv("AFFINITY_MAINTENANCE_FILE")
	if api.MaintenanceFile == "" {
		executable, errPath := os.Executable()
		if errPath != nil {
			return errPath
		}
		api.MaintenanceFile = filepath.Join(filepath.Dir(executable), "affinity-maintenance.lock")
	}
	server := &http.Server{Addr: addr, Handler: api.Handler()}
	go func() {
		<-ctx.Done()
		if errClose := server.Shutdown(context.Background()); errClose != nil {
			log.Error("Affinity HTTP shutdown failed")
		}
	}()
	log.WithField("address", addr).Info("Affinity control service listening")
	err = server.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
