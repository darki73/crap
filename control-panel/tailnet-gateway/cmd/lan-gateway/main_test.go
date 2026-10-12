package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type authority struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newCA(t *testing.T) authority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	c := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, c, c, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ = x509.ParseCertificate(der)
	return authority{c, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}
func (a authority) issue(t *testing.T, client bool, identity string, serial int64, expired bool) (tls.Certificate, []byte, []byte) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	c := &x509.Certificate{SerialNumber: big.NewInt(serial), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, DNSNames: []string{"lan.example.com"}}
	if expired {
		c.NotAfter = time.Now().Add(-time.Minute)
	}
	if client {
		c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		u, _ := url.Parse(identity)
		c.URIs = []*url.URL{u}
	} else {
		c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, c, a.cert, &key.PublicKey, a.key)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	cp, kp := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb})
	pair, err := tls.X509KeyPair(cp, kp)
	if err != nil {
		t.Fatal(err)
	}
	return pair, cp, kp
}
func writeBundle(t *testing.T, dir string, a authority, serial int64) {
	t.Helper()
	_, cp, kp := a.issue(t, false, "", serial, false)
	for name, data := range map[string][]byte{"tls.crt": cp, "tls.key": kp, "ca.crt": a.pem} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
func fixture(t *testing.T, backend http.Handler) (authority, string, *httptest.Server) {
	t.Helper()
	a := newCA(t)
	dir := t.TempDir()
	writeBundle(t, dir, a, 2)
	b := httptest.NewServer(backend)
	t.Cleanup(b.Close)
	u, _ := url.Parse(b.URL)
	s := httptest.NewUnstartedServer(handler(settings{origin: "https://lan.example.com", panel: u, api: u}))
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.TLS = &tls.Config{GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) { return loadTLS(dir) }}
	s.StartTLS()
	t.Cleanup(s.Close)
	return a, dir, s
}
func client(a authority, cert *tls.Certificate) *http.Client {
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(a.pem)
	conf := &tls.Config{RootCAs: pool, ServerName: "lan.example.com", MinVersion: tls.VersionTLS12}
	if cert != nil {
		conf.Certificates = []tls.Certificate{*cert}
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: conf, DisableKeepAlives: true}, Timeout: 5 * time.Second}
}
func request(t *testing.T, c *http.Client, s *httptest.Server, method, path, key, origin string) (*http.Response, error) {
	t.Helper()
	r, _ := http.NewRequest(method, s.URL+path, nil)
	r.Host = "lan.example.com"
	r.Header.Set("X-Api-Key", key)
	r.Header.Set("Origin", origin)
	r.Header.Set("X-Forwarded-For", "spoofed")
	return c.Do(r)
}
func TestMutualTLSIdentityAndRotation(t *testing.T) {
	a, dir, s := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	good, _, _ := a.issue(t, true, clientIdentity, 3, false)
	wrong, _, _ := a.issue(t, true, "urn:crap:lan:other", 4, false)
	expired, _, _ := a.issue(t, true, clientIdentity, 5, true)
	foreign, _, _ := newCA(t).issue(t, true, clientIdentity, 6, false)
	for name, cert := range map[string]*tls.Certificate{"missing": nil, "wrong identity": &wrong, "expired": &expired, "foreign CA": &foreign} {
		t.Run(name, func(t *testing.T) {
			resp, err := request(t, client(a, cert), s, "GET", "/", "", "")
			if err == nil {
				resp.Body.Close()
				t.Fatal("untrusted connection admitted")
			}
		})
	}
	for _, serial := range []int64{2, 42} {
		writeBundle(t, dir, a, serial)
		resp, err := request(t, client(a, &good), s, "GET", "/", "", "")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 204 || resp.TLS.PeerCertificates[0].SerialNumber.Int64() != serial {
			t.Fatal("certificate update was not loaded")
		}
	}
	renewed, _, _ := a.issue(t, true, clientIdentity, 7, false)
	resp, err := request(t, client(a, &renewed), s, "GET", "/", "", "")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if err := os.WriteFile(filepath.Join(dir, "ca.crt"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	resp, err = request(t, client(a, &good), s, "GET", "/", "", "")
	if err == nil {
		resp.Body.Close()
		t.Fatal("invalid rotation did not fail closed")
	}
}
func TestRoutesOriginHeadersAndNoReplay(t *testing.T) {
	calls := 0
	a, _, s := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("X-Forwarded-For") != "" {
			t.Error("forwarded identity leaked")
		}
		if strings.HasPrefix(r.URL.Path, "/v1/") && r.Header.Get("X-Api-Key") != "fixture-key" {
			t.Error("API key lost")
		}
		if r.URL.Path == "/v1/messages" {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(204)
	}))
	cert, _, _ := a.issue(t, true, clientIdentity, 3, false)
	c := client(a, &cert)
	for _, tc := range []struct {
		method, path, key, origin string
		status                    int
	}{
		{"GET", "/", "", "", 204}, {"GET", "/api/health", "", "https://lan.example.com", 204},
		{"GET", "/", "", "https://evil.example.com", 403},
		{"GET", "/v1/models", "", "", 401}, {"GET", "/v1/models", "fixture-key", "", 204},
		{"POST", "/v1/messages", "fixture-key", "", 503},
		{"GET", "/v8/management/config", "fixture-key", "", 404},
		{"GET", "/readyz", "fixture-key", "", 404}, {"GET", "/v1/unknown", "fixture-key", "", 404},
		{"DELETE", "/v1/models", "fixture-key", "", 404}, {"GET", "/v1/%6dodels", "fixture-key", "", 404},
	} {
		resp, err := request(t, c, s, tc.method, tc.path, tc.key, tc.origin)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.status {
			t.Errorf("%s %s: %d want %d", tc.method, tc.path, resp.StatusCode, tc.status)
		}
	}
	if calls != 4 {
		t.Fatalf("unexpected backend calls or replay: %d", calls)
	}
	r, _ := http.NewRequest("GET", s.URL, nil)
	r.Host = "other.example.com"
	resp, err := c.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("wrong host admitted")
	}
}
func TestStreamingAndCancellation(t *testing.T) {
	canceled := make(chan struct{})
	a, _, s := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(canceled)
	}))
	cert, _, _ := a.issue(t, true, clientIdentity, 3, false)
	resp, err := request(t, client(a, &cert), s, "POST", "/v1/messages", "fixture-key", "")
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("stream buffered: %q %v", line, err)
	}
	resp.Body.Close()
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnected client did not cancel backend")
	}
}
func TestSettingsFailClosed(t *testing.T) {
	for _, origin := range []string{"", "http://lan.example.com", "https://user@lan.example.com", "https://lan.example.com/path"} {
		t.Setenv("CRAP_LAN_ORIGIN", origin)
		if _, err := readSettings(); err == nil {
			t.Fatalf("accepted %q", origin)
		}
	}
	t.Setenv("CRAP_LAN_ORIGIN", "https://lan.example.com")
	t.Setenv("CRAP_LAN_API_URL", "https://provider.example.com")
	if _, err := readSettings(); err == nil {
		t.Fatal("accepted non-local TLS backend")
	}
}
