// SPDX-License-Identifier: Apache-2.0

// Package auth signs users in with Cenacle ID (OpenID Connect, authorization
// code flow with PKCE) and manages the chat server's own sessions.
//
// The IdP's tokens are used only during sign-in. Afterwards the user holds an
// opaque session token: random, stored in the database as a SHA-256 hash,
// sent as an HttpOnly cookie by the web app or as a bearer token by other
// clients.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/store"
)

// ErrNoSession means the token is unknown, expired or idle for too long.
var ErrNoSession = errors.New("no active session")

// tokenBytes is the entropy of a session token (256 bits).
const tokenBytes = 32

// newToken returns a random token and its hash.
func newToken() (string, []byte) {
	b := make([]byte, tokenBytes)
	_, _ = rand.Read(b) // never fails (crypto/rand)
	token := base64.RawURLEncoding.EncodeToString(b)
	return token, hashToken(token)
}

// hashToken is SHA-256: tokens carry 256 random bits, so a slow password hash
// would add cost without adding security.
func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// validTokenFormat rejects obviously malformed tokens before a database round trip.
func validTokenFormat(token string) bool {
	return len(token) == base64.RawURLEncoding.EncodedLen(tokenBytes)
}

// Principal is the authenticated session of a request and its user.
type Principal struct {
	Session store.Session
	User    store.User
	// IP is the client address of the request (for the audit log).
	IP string
	// Bot is set for requests with a bot token (Session is empty then).
	Bot *BotPrincipal
}

// ClientInfo describes the client a session is used from.
type ClientInfo struct {
	UserAgent string
	IP        string
}

// maxUserAgent bounds what is stored per session.
const maxUserAgent = 512

func (c ClientInfo) userAgent() string {
	ua := c.UserAgent
	if len(ua) > maxUserAgent {
		ua = ua[:maxUserAgent]
	}
	return ua
}

// Sessions creates, checks and ends sessions.
type Sessions struct {
	Queries store.Querier
	// IdleTimeout ends sessions that were not used for this long.
	IdleTimeout time.Duration
	// MaxAge is the absolute lifetime of a session.
	MaxAge time.Duration
}

// Create starts a session for userID and returns its token. idpSID is the
// identity provider's session it came from ("" if unknown).
func (s *Sessions) Create(ctx context.Context, userID pgtype.UUID, client ClientInfo, idpSID string) (string, store.Session, error) {
	token, hash := newToken()
	sess, err := s.Queries.CreateSession(ctx, store.CreateSessionParams{
		UserID:    userID,
		TokenHash: hash,
		ExpiresAt: time.Now().Add(s.MaxAge),
		UserAgent: client.userAgent(),
		IpAddress: client.IP,
		IdpSid:    idpSID,
	})
	if err != nil {
		return "", store.Session{}, fmt.Errorf("create session: %w", err)
	}
	return token, sess, nil
}

// Authenticate returns the active session of token and records its use.
func (s *Sessions) Authenticate(ctx context.Context, token string, client ClientInfo) (Principal, error) {
	if !validTokenFormat(token) {
		return Principal{}, ErrNoSession
	}
	row, err := s.Queries.GetActiveSession(ctx, store.GetActiveSessionParams{
		TokenHash:   hashToken(token),
		IdleTimeout: interval(s.IdleTimeout),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrNoSession
	}
	if err != nil {
		return Principal{}, fmt.Errorf("get session: %w", err)
	}
	if err := s.Queries.TouchSession(ctx, store.TouchSessionParams{
		ID:        row.Session.ID,
		UserAgent: client.userAgent(),
		IpAddress: client.IP,
	}); err != nil {
		return Principal{}, fmt.Errorf("touch session: %w", err)
	}
	return Principal{Session: row.Session, User: row.User}, nil
}

// SessionActive reports whether a session can still be used, without
// recording use.
func (s *Sessions) SessionActive(ctx context.Context, id pgtype.UUID) (bool, error) {
	return s.Queries.SessionIsActive(ctx, store.SessionIsActiveParams{ID: id, IdleTimeout: interval(s.IdleTimeout)})
}

// Delete ends a session.
func (s *Sessions) Delete(ctx context.Context, id pgtype.UUID) error {
	return s.Queries.DeleteSession(ctx, id)
}

// DeleteExpired removes sessions that can no longer be used.
func (s *Sessions) DeleteExpired(ctx context.Context) (int64, error) {
	return s.Queries.DeleteExpiredSessions(ctx, interval(s.IdleTimeout))
}

func interval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: d.Microseconds(), Valid: true}
}
