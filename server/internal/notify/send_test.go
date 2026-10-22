// SPDX-License-Identifier: Apache-2.0

package notify

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/egress"
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
	gone = true
	if err := p.Send(ctx, srv.URL+"/sub", b64(key.PublicKey().Bytes()), b64(auth), payload); !errors.Is(err, ErrGone) {
		t.Errorf("gone subscription = %v", err)
	}
	// The egress policy still applies: a private address outside the allow list.
	if err := p.Send(ctx, "http://10.0.0.1/sub", b64(key.PublicKey().Bytes()), b64(auth), payload); err == nil {
		t.Error("a private address was reached")
	}
}

func TestTopic(t *testing.T) {
	if got := topic("c-01a15e50-2335-7d7d-bbee-8e7809fd8ad2"); len(got) > 32 || strings.ContainsAny(got, "/ ") {
		t.Errorf("topic = %q", got)
	}
}
