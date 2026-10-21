// SPDX-License-Identifier: Apache-2.0

package realtime

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// TicketTTL is how long a WebSocket ticket can be used.
const TicketTTL = 30 * time.Second

// TicketStore keeps tickets; Take must return a value at most once (GETDEL).
type TicketStore interface {
	PutNew(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Take(ctx context.Context, key string) ([]byte, error)
}

type ticket struct {
	SessionID pgtype.UUID `json:"session_id"`
	UserID    pgtype.UUID `json:"user_id"`
}

func ticketKey(t string) string { return "cenacle:ws:ticket:" + t }

func issueTicket(ctx context.Context, store TicketStore, t ticket) (string, error) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	token := base64.RawURLEncoding.EncodeToString(b)
	value, _ := json.Marshal(t)
	if err := store.PutNew(ctx, ticketKey(token), value, TicketTTL); err != nil {
		return "", err
	}
	return token, nil
}

func redeemTicket(ctx context.Context, store TicketStore, token string) (ticket, error) {
	var t ticket
	if len(token) != base64.RawURLEncoding.EncodedLen(32) {
		return t, errInvalidTicket
	}
	raw, err := store.Take(ctx, ticketKey(token))
	if err != nil {
		return t, errInvalidTicket
	}
	if err := json.Unmarshal(raw, &t); err != nil {
		return t, errInvalidTicket
	}
	return t, nil
}
