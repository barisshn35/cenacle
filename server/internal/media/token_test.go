// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type tokenMemory struct {
	mu     sync.Mutex
	values map[string][]byte
}

func (m *tokenMemory) PutNew(_ context.Context, key string, value []byte, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.values[key]; ok {
		return errors.New("exists")
	}
	m.values[key] = value
	return nil
}
func (m *tokenMemory) Take(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.values[key]
	delete(m.values, key)
	if !ok {
		return nil, errors.New("missing")
	}
	return value, nil
}

// Operator: go test ./internal/media -run TestAdmissionToken
// This test is intentionally not executed on the authoring PC.
func TestAdmissionToken(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1804442400, 0)
	memory := &tokenMemory{values: map[string][]byte{}}
	service := Tokens{Private: private, Public: public, KeyID: "calls-1", Issuer: "https://chat.invalid", Store: memory, Now: func() time.Time { return now }}
	grant := Grant{UserID: uuid.NewString(), CallID: uuid.NewString(), ParticipantID: uuid.NewString(), SessionID: uuid.NewString(), NodeGeneration: uuid.NewString()}
	token, err := service.Issue(context.Background(), grant)
	if err != nil {
		t.Fatal(err)
	}
	got, err := service.Redeem(context.Background(), token, grant.NodeGeneration)
	if err != nil || got.UserID != grant.UserID || got.ParticipantID != grant.ParticipantID {
		t.Fatalf("redeem: %v", err)
	}
	if _, err = service.Redeem(context.Background(), token, grant.NodeGeneration); err == nil {
		t.Fatal("replay accepted")
	}
	token, err = service.Issue(context.Background(), grant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Redeem(context.Background(), token, uuid.NewString()); err == nil {
		t.Fatal("wrong node accepted")
	}
	if _, err = service.Redeem(context.Background(), token, grant.NodeGeneration); err != nil {
		t.Fatal("invalid claim check consumed valid grant")
	}
	token, err = service.Issue(context.Background(), grant)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(60 * time.Second)
	if _, err = service.Redeem(context.Background(), token, grant.NodeGeneration); err == nil {
		t.Fatal("expired token accepted")
	}
	if _, err = service.Redeem(context.Background(), "not-a-token", grant.NodeGeneration); err == nil {
		t.Fatal("malformed token accepted")
	}
}
