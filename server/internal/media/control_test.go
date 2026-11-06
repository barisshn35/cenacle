// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Operator: go test ./internal/media -run TestControlSignature
func TestControlSignature(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	request := Control{Grant: Grant{UserID: uuid.NewString(), CallID: uuid.NewString(), ParticipantID: uuid.NewString(), SessionID: uuid.NewString(), NodeGeneration: uuid.NewString()}, Action: "authorize", TransportGeneration: 1}
	raw, err := SignControl(private, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = VerifyControl(public, raw, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = VerifyControl(public, raw, time.Now().Add(31*time.Second)); err == nil {
		t.Fatal("stale control accepted")
	}
	wrong, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = VerifyControl(wrong, raw, time.Now()); err == nil {
		t.Fatal("wrong signer accepted")
	}
}
