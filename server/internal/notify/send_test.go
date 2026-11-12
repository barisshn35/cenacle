// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/egress"
)

func TestPushSend(t *testing.T) {
	var gotAuth, gotEncoding string
	var gotBody []byte
	gone := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotEncoding = r.Header.Get("Authorization"), r.Header.Get("Content-Encoding")
		gotBody, _ = io.ReadAll(r.Body)
		if gone {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	// A browser's subscription keys.
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	public, private, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	p := &Push{
		Egress: egress.New(egress.Policy{
			Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}, AllowHTTP: true,
		}),
		Subscriber: "mailto:admin@example.com", PublicKey: public, PrivateKey: private,
	}
	b64 := base64.RawURLEncoding.EncodeToString
	ctx := context.Background()
	payload := Payload{Title: "Ayşe · General", Body: "Merhaba", URL: "https://chat.example/c/1", Tag: "c-1"}
	if err := p.Send(ctx, srv.URL+"/sub", b64(key.PublicKey().Bytes()), b64(auth), payload); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(gotAuth, "vapid t=") || gotEncoding != "aes128gcm" || len(gotBody) == 0 {
		t.Errorf("request: auth %q, encoding %q, %d bytes", gotAuth, gotEncoding, len(gotBody))
	}
	if strings.Contains(string(gotBody), "Merhaba") {
		t.Error("the payload went out unencrypted")
	}
	// Only the browser can read it: decrypted as RFC 8291 (aes128gcm, RFC 8188)
	// says, with the subscription's private key and auth secret.
	plain, err := decryptWebPush(gotBody, key, auth)
	if err != nil {
		t.Fatalf("decrypt as RFC 8291: %v", err)
	}
	var got Payload
	if err := json.Unmarshal(plain, &got); err != nil || got.Body != "Merhaba" || got.Title != payload.Title {
		t.Errorf("decrypted payload = %s (%v)", plain, err)
	}
	gone = true
	if err := p.Send(ctx, srv.URL+"/sub", b64(key.PublicKey().Bytes()), b64(auth), payload); !errors.Is(err, ErrGone) {
		t.Errorf("gone subscription = %v", err)
	}
	// The egress policy still applies: a private address outside the allow list.
	if err := p.Send(ctx, "http://10.0.0.1/sub", b64(key.PublicKey().Bytes()), b64(auth), payload); err == nil {
		t.Error("a private address was reached")
	}
}

// Push endpoints come from browsers: the push client reaches neither plain
// http nor internal networks, whatever the operator allows bots.
func TestPushEgressIsStrict(t *testing.T) {
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	public, private, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	p := &Push{Egress: PushEgress(), Subscriber: "mailto:admin@example.com", PublicKey: public, PrivateKey: private}
	b64 := base64.RawURLEncoding.EncodeToString
	for _, endpoint := range []string{"https://127.0.0.1/sub", "https://10.0.5.7/sub", "https://[64:ff9b::a00:1]/sub", "http://push.example.com/sub"} {
		if err := p.Send(context.Background(), endpoint, b64(key.PublicKey().Bytes()), b64(auth), Payload{Title: "x"}); err == nil {
			t.Errorf("%s reached", endpoint)
		}
	}
	if _, err := PushEgress().CheckURL("http://push.example.com/sub"); err == nil {
		t.Error("plain http allowed")
	}
}

func TestTopic(t *testing.T) {
	if got := topic("c-01a15e50-2335-7d7d-bbee-8e7809fd8ad2"); len(got) > 32 || strings.ContainsAny(got, "/ ") {
		t.Errorf("topic = %q", got)
	}
}

func TestMailMessage(t *testing.T) {
	from, _ := mail.ParseAddress("Cenacle <chat@example.com>")
	to, _ := mail.ParseAddress("mert@example.com")
	msg, err := Mail{Subject: "Hi", Text: "Merhaba\nline two"}.message(from, to, time.Now())
	if err != nil || !strings.Contains(string(msg), "Merhaba\r\nline two") {
		t.Fatalf("plain message: %v\n%s", err, msg)
	}
}

// decryptWebPush reads a web push message as a browser does (RFC 8291 over the
// aes128gcm content coding of RFC 8188): the header carries the salt, the
// record size and the server's one-time public key; the content key and nonce
// come from ECDH with the subscription's key, mixed with its auth secret.
func decryptWebPush(body []byte, ua *ecdh.PrivateKey, authSecret []byte) ([]byte, error) {
	if len(body) < 21 {
		return nil, errors.New("short header")
	}
	salt, idLen := body[:16], int(body[20])
	if len(body) < 21+idLen {
		return nil, errors.New("short key id")
	}
	asPublicRaw, ciphertext := body[21:21+idLen], body[21+idLen:]
	asPublic, err := ecdh.P256().NewPublicKey(asPublicRaw)
	if err != nil {
		return nil, fmt.Errorf("server key: %w", err)
	}
	shared, err := ua.ECDH(asPublic)
	if err != nil {
		return nil, err
	}
	hmacOf := func(key []byte, parts ...[]byte) []byte {
		m := hmac.New(sha256.New, key)
		for _, p := range parts {
			m.Write(p)
		}
		return m.Sum(nil)
	}
	// IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public, 32)
	info := append(append([]byte("WebPush: info\x00"), ua.PublicKey().Bytes()...), asPublicRaw...)
	ikm := hmacOf(hmacOf(authSecret, shared), info, []byte{1})
	prk := hmacOf(salt, ikm)
	cek := hmacOf(prk, []byte("Content-Encoding: aes128gcm\x00"), []byte{1})[:16]
	nonce := hmacOf(prk, []byte("Content-Encoding: nonce\x00"), []byte{1})[:12]
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	// The last record ends with the delimiter 2, then zero padding.
	end := bytes.LastIndexByte(plain, 2)
	if end < 0 || bytes.Count(plain[end+1:], []byte{0}) != len(plain)-end-1 {
		return nil, errors.New("no last-record delimiter")
	}
	return plain[:end], nil
}
