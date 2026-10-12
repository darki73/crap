package main

import (
	"context"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"cliproxy-affinity-router/gateway"
	log "github.com/sirupsen/logrus"
)

func main() {
	if err := run(); err != nil {
		log.Error("CRAP API gateway stopped; check service configuration")
		os.Exit(1)
	}
}
func run() error {
	proxy, err := url.Parse(os.Getenv("PROXY_URL"))
	if err != nil {
		return err
	}
	control, err := url.Parse(os.Getenv("AFFINITY_CONTROL_URL"))
	if err != nil {
		return err
	}
	for _, u := range []*url.URL{proxy, control} {
		if u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return errors.New("invalid dependency URL")
		}
	}
	if len(os.Getenv("MANAGEMENT_KEY")) < 32 || len(os.Getenv("AFFINITY_CONTROL_TOKEN")) < 32 {
		return errors.New("missing credentials")
	}
	g := &gateway.Gateway{Proxy: proxy, Control: control, ManagementKey: os.Getenv("MANAGEMENT_KEY"), ControlToken: os.Getenv("AFFINITY_CONTROL_TOKEN"), Client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	var privateServers []*http.Server
	// Optional local development management relay. Publish this listener on
	// loopback only; the proxy still authenticates every management operation.
	if address := os.Getenv("CRAP_LOCAL_ADMIN_LISTEN"); address != "" {
		listener, errListen := net.Listen("tcp", address)
		if errListen != nil {
			return errListen
		}
		relay := httputil.NewSingleHostReverseProxy(proxy)
		admin := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/v8/management/") || strings.Contains(r.URL.Path, "..") || strings.ContainsAny(r.URL.Path, "\\%") {
				http.NotFound(w, r)
				return
			}
			relay.ServeHTTP(w, r)
		})}
		privateServers = append(privateServers, admin)
		go func() {
			if errServe := admin.Serve(listener); errServe != nil && !errors.Is(errServe, http.ErrServerClosed) {
				g.Drain()
				log.Error("Local management relay stopped")
			}
		}()
	}
	if os.Getenv("CRAP_STRICT_ROUTING") == "1" {
		key, errKey := hex.DecodeString(os.Getenv("AFFINITY_ID_KEY"))
		if errKey != nil || len(key) < 32 {
			return errors.New("missing strict identity key")
		}
		outbound := os.Getenv("CRAP_OUTBOUND_URL")
		parsed, errURL := url.Parse(outbound)
		if errURL != nil || parsed.Host == "" || parsed.Scheme != "http" {
			return errors.New("invalid outbound gate URL")
		}
		g.Strict = &gateway.StrictGate{Gateway: g, Key: key, OutboundURL: outbound}
		for _, endpoint := range []struct {
			Address string
			Handler http.Handler
		}{{os.Getenv("CRAP_INTERNAL_LISTEN"), g.Strict.Internal()}, {os.Getenv("CRAP_EGRESS_LISTEN"), g.Strict.Egress()}} {
			if endpoint.Address == "" {
				return errors.New("strict private listeners required")
			}
			listener, errListen := net.Listen("tcp", endpoint.Address)
			if errListen != nil {
				return errListen
			}
			private := &http.Server{Handler: endpoint.Handler}
			privateServers = append(privateServers, private)
			go func() {
				if errServe := private.Serve(listener); errServe != nil && !errors.Is(errServe, http.ErrServerClosed) {
					g.Drain()
					log.Error("Strict private listener stopped")
				}
			}()
		}
	}
	address := os.Getenv("AFFINITY_GATEWAY_LISTEN")
	if address == "" {
		address = "127.0.0.1:8319"
	}
	server := &http.Server{Addr: address, Handler: g.Handler()}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	drained := make(chan struct{})
	go func() {
		<-ctx.Done()
		g.Drain()
		log.Info("Gateway draining active requests")
		if err := server.Shutdown(context.Background()); err != nil {
			log.Error("Gateway drain failed")
		}
		g.Wait()
		for _, private := range privateServers {
			_ = private.Close()
		}
		close(drained)
	}()
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	log.WithField("address", listener.Addr().String()).Info("CRAP checked API entrypoint listening")
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		<-drained
		return nil
	}
	return err
}
