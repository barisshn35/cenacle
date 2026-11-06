// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/fips140"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pion/turn/v5"
)

// Operator: go test ./internal/media -run TestTURNOverTLSAndTargetRestriction
// The client uses TLS only; the relay's destination is a local media fixture.
// No public STUN/TURN server, external network or test execution is used here.
func TestTURNOverTLSAndTargetRestriction(t *testing.T) {
	if fips140.Enabled() {
		t.Skip("embedded TURN refuses FIPS mode")
	}
	certificate, key, roots := fixtureTLSCertificate(t)
	entropy := make([]byte, 32)
	if _, err := rand.Read(entropy); err != nil {
		t.Fatal(err)
	}
	secret := base64.RawStdEncoding.EncodeToString(entropy)
	echo, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = echo.Close() }()
	blocked, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocked.Close() }()
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, from, err := echo.ReadFrom(buffer)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(buffer[:n], from)
		}
	}()
	grant := fixtureGrant(uuid.NewString())
	peer := &mediaPeer{grant: grant, generation: 1}
	peer.ready.Store(true)
	peer.connected.Store(true)
	peer.authorizedUntil.Store(time.Now().Add(time.Minute).UnixNano())
	engine := &SFU{cfg: SFUConfig{PublicIP: "127.0.0.1"}, udp: echo, peers: map[string]*mediaPeer{grant.ParticipantID: peer}}
	err = engine.startTURN(TURNConfig{Secret: secret, Certificate: certificate, PrivateKey: key, UDPAddr: "127.0.0.1:0", TLSAddr: "127.0.0.1:0", MinPort: 49152, MaxPort: 49407, MaxAllocations: 4})
	if err != nil {
		t.Fatal("TURN fixture startup failed")
	}
	defer func() { _ = engine.turn.Close() }()
	credentials, err := TURNServerCredentials(secret, nil, grant.ParticipantID, time.Now())
	if err != nil {
		t.Fatal("credential fixture failed")
	}
	address := engine.turn.tlsListener.Addr().String()
	tlsConnection, err := tls.DialWithDialer(&net.Dialer{Timeout: 3 * time.Second}, "tcp", address, &tls.Config{RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal("trusted TURN TLS connection failed")
	}
	defer func() { _ = tlsConnection.Close() }()
	client, err := turn.NewClient(&turn.ClientConfig{STUNServerAddr: address, TURNServerAddr: address, Conn: turn.NewSTUNConn(tlsConnection), Username: credentials.Username, Password: credentials.Credential, Realm: turnRealm, LoggerFactory: mediaLogger, RTO: 100 * time.Millisecond})
	if err != nil {
		t.Fatal("TURN client setup failed")
	}
	defer client.Close()
	if err = client.Listen(); err != nil {
		t.Fatal("TURN client listener failed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	relay, err := client.AllocateWithContext(ctx)
	if err != nil {
		t.Fatal("TURN TLS allocation failed")
	}
	defer func() { _ = relay.Close() }()
	payload := []byte("local-media-fixture")
	if _, err = relay.WriteTo(payload, echo.LocalAddr()); err != nil {
		t.Fatal("media relay write failed")
	}
	_ = relay.SetReadDeadline(time.Now().Add(3 * time.Second))
	buffer := make([]byte, 1500)
	n, _, err := relay.ReadFrom(buffer)
	if err != nil || !bytes.Equal(buffer[:n], payload) {
		t.Fatal("media payload did not return over TLS")
	}
	_, _ = relay.WriteTo([]byte("must-not-arrive"), blocked.LocalAddr())
	_ = blocked.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, _, err = blocked.ReadFrom(buffer); err == nil {
		t.Fatal("TURN relayed to an unauthorized port")
	} else if timeout := net.Error(nil); !errors.As(err, &timeout) || !timeout.Timeout() {
		t.Fatal("blocked fixture failed unexpectedly")
	}
}

func fixtureTLSCertificate(t *testing.T) (string, string, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal("certificate fixture key failed")
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal("certificate fixture failed")
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal("certificate fixture encoding failed")
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal("certificate fixture parsing failed")
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})), roots
}
