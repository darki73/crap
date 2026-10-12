// Disposable fixture certificate generator and network reachability probe.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"time"
)

func run() error {
	if len(os.Args) == 3 && os.Args[1] == "probe" {
		conn, err := net.DialTimeout("tcp", os.Args[2], 2*time.Second)
		if err != nil {
			fmt.Println("unreachable")
			return nil
		}
		_ = conn.Close()
		return fmt.Errorf("unexpected direct connectivity")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "CRAP disposable fixture"}, DNSNames: []string{"provider", "api.anthropic.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(1, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return err
	}
	priv, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.WriteFile("/out/ca.pem", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0644); err != nil {
		return err
	}
	return os.WriteFile("/out/key.pem", pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: priv}), 0600)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
