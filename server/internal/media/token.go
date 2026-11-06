// SPDX-License-Identifier: AGPL-3.0-only

// Package media implements the isolated call media service.
package media

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

const TokenTTL = 60 * time.Second

var ErrAdmission = errors.New("media admission denied")

// Grant binds admission to one authenticated session and room generation.
// These identifiers are not a session bearer credential.
type Grant struct {
	UserID         string `json:"sub"`
	CallID         string `json:"call_id"`
	ParticipantID  string `json:"participant_id"`
	SessionID      string `json:"session_id"`
	NodeGeneration string `json:"node_generation"`
}
type admission struct {
	Grant
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	ID        string `json:"jti"`
	IssuedAt  int64  `json:"iat"`
	NotBefore int64  `json:"nbf"`
	Expires   int64  `json:"exp"`
}

// TokenStore must consume a value atomically, including across media processes.
type TokenStore interface {
	PutNew(context.Context, string, []byte, time.Duration) error
	Take(context.Context, string) ([]byte, error)
}

// Tokens has a private key only in the chat process. The media process receives
// a public key and cannot mint admission credentials.
type Tokens struct {
	Private       ed25519.PrivateKey
	Public        ed25519.PublicKey
	KeyID, Issuer string
	Store         TokenStore
	Now           func() time.Time
}

func (t *Tokens) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}
func validGrant(g Grant) bool {
	for _, s := range []string{g.UserID, g.CallID, g.ParticipantID, g.SessionID, g.NodeGeneration} {
		id, err := uuid.Parse(s)
		if err != nil || id == uuid.Nil {
			return false
		}
	}
	return true
}
func tokenKey(id string) string {
	sum := sha256.Sum256([]byte(id))
	return "cenacle:media:token:" + hex.EncodeToString(sum[:])
}

func (t *Tokens) Issue(ctx context.Context, g Grant) (string, error) {
	if !validGrant(g) || len(t.Private) != ed25519.PrivateKeySize || t.KeyID == "" || t.Issuer == "" || t.Store == nil {
		return "", ErrAdmission
	}
	now := t.now().Unix()
	a := admission{Grant: g, Issuer: t.Issuer, Audience: "cenacle-media", ID: uuid.NewString(), IssuedAt: now, NotBefore: now, Expires: now + 60}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: t.Private}, (&jose.SignerOptions{}).WithType("cenacle-call+jwt").WithHeader("kid", t.KeyID))
	if err != nil {
		return "", ErrAdmission
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return "", ErrAdmission
	}
	signed, err := signer.Sign(raw)
	if err != nil {
		return "", ErrAdmission
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		return "", ErrAdmission
	}
	if err = t.Store.PutNew(ctx, tokenKey(a.ID), []byte("1"), TokenTTL); err != nil {
		return "", ErrAdmission
	}
	return token, nil
}

// Redeem verifies before consuming. Errors deliberately reveal neither claims
// nor serialized credentials; callers must not log the input frame.
func (t *Tokens) Redeem(ctx context.Context, token, nodeGeneration string) (Grant, error) {
	if len(token) > 4096 || strings.Count(token, ".") != 2 || len(t.Public) != ed25519.PublicKeySize || t.KeyID == "" || t.Issuer == "" || t.Store == nil {
		return Grant{}, ErrAdmission
	}
	signed, err := jose.ParseSigned(token, []jose.SignatureAlgorithm{jose.EdDSA})
	if err != nil || len(signed.Signatures) != 1 {
		return Grant{}, ErrAdmission
	}
	header := signed.Signatures[0].Protected
	if header.KeyID != t.KeyID || header.Algorithm != string(jose.EdDSA) || header.ExtraHeaders[jose.HeaderType] != "cenacle-call+jwt" {
		return Grant{}, ErrAdmission
	}
	raw, err := signed.Verify(t.Public)
	if err != nil {
		return Grant{}, ErrAdmission
	}
	var a admission
	if json.Unmarshal(raw, &a) != nil || !validGrant(a.Grant) || a.NodeGeneration != nodeGeneration || a.Issuer != t.Issuer || a.Audience != "cenacle-media" {
		return Grant{}, ErrAdmission
	}
	id, err := uuid.Parse(a.ID)
	if err != nil || id == uuid.Nil {
		return Grant{}, ErrAdmission
	}
	now := t.now().Unix()
	if a.Expires-a.IssuedAt != 60 || a.NotBefore != a.IssuedAt || a.IssuedAt > now || a.Expires <= now {
		return Grant{}, ErrAdmission
	}
	marker, err := t.Store.Take(ctx, tokenKey(a.ID))
	if err != nil || string(marker) != "1" {
		return Grant{}, ErrAdmission
	}
	return a.Grant, nil
}
