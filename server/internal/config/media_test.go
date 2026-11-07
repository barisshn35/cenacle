// SPDX-License-Identifier: AGPL-3.0-only
package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
)

// Operator: go test ./internal/config -run 'TestCallsDefaultOff|TestMediaKeySeparation'
func TestCallsDefaultOff(t *testing.T) {
	loader := loader{lookup: env(nil), readFile: files(nil)}
	if loadCalls(&loader) != nil || len(loader.errs) != 0 {
		t.Fatal("calls enabled or keys required by default")
	}
}
func TestMediaKeySeparation(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{"CENACLE_PUBLIC_URL": "https://chat.invalid", "CENACLE_CALLS_PUBLIC_KEY_FILE": "public", "CENACLE_MEDIA_CONTROL_PRIVATE_KEY_FILE": "control", "CENACLE_MEDIA_PUBLIC_IP": "192.0.2.10"}
	material := map[string]string{"public": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})), "control": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}))}
	result, err := LoadMedia(env(values), files(material))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.AdmissionPublic) != ed25519.PublicKeySize || len(result.ControlPrivate) != ed25519.PrivateKeySize {
		t.Fatal("keys not loaded")
	}
	if result.ICEUDPAddr != ":7882" || result.ICETCPAddr != ":7881" {
		t.Errorf("ICE ports = %s, %s", result.ICEUDPAddr, result.ICETCPAddr)
	}
	// Other ports (a second media node on one host), but always fixed ones.
	values["CENACLE_MEDIA_ICE_UDP_ADDR"], values["CENACLE_MEDIA_ICE_TCP_ADDR"] = ":17882", "10.0.0.5:17881"
	if result, err = LoadMedia(env(values), files(material)); err != nil || result.ICEUDPAddr != ":17882" || result.ICETCPAddr != "10.0.0.5:17881" {
		t.Errorf("ICE ports = %+v, %v", result, err)
	}
	for _, bad := range []string{"7882", ":0", "media:"} {
		values["CENACLE_MEDIA_ICE_UDP_ADDR"] = bad
		if _, err := LoadMedia(env(values), files(material)); err == nil {
			t.Errorf("ICE UDP address %q accepted", bad)
		}
	}
	delete(values, "CENACLE_MEDIA_ICE_UDP_ADDR")
	delete(values, "CENACLE_MEDIA_ICE_TCP_ADDR")
	values["CENACLE_CALLS_PUBLIC_KEY"] = material["control"]
	if _, err = LoadMedia(env(values), files(material)); err == nil {
		t.Fatal("private key or duplicate source accepted as public key")
	}
}

// The public media address is operator-supplied and may never fall back to
// unspecified, loopback, multicast, link-local or a discovered hostname.
func TestMediaPublicAddressAndOriginValidation(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	material := map[string]string{
		"public":  string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})),
		"control": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER})),
	}
	base := map[string]string{"CENACLE_PUBLIC_URL": "https://chat.invalid", "CENACLE_CALLS_PUBLIC_KEY_FILE": "public", "CENACLE_MEDIA_CONTROL_PRIVATE_KEY_FILE": "control"}
	for _, address := range []string{"", "127.0.0.1", "::1", "0.0.0.0", "169.254.1.1", "224.0.0.1", "media.example.test", "999.1.1.1"} {
		base["CENACLE_MEDIA_PUBLIC_IP"] = address
		if _, err := LoadMedia(env(base), files(material)); err == nil {
			t.Errorf("invalid public address %q accepted", address)
		}
	}
	base["CENACLE_MEDIA_PUBLIC_IP"] = "192.0.2.10"
	base["CENACLE_PUBLIC_URL"] = "http://chat.example.test"
	if _, err := LoadMedia(env(base), files(material)); err == nil {
		t.Fatal("insecure non-loopback origin accepted")
	}
	base["CENACLE_PUBLIC_URL"] = "http://localhost:5273"
	if _, err := LoadMedia(env(base), files(material)); err != nil {
		t.Fatalf("loopback development origin rejected: %v", err)
	}
}
