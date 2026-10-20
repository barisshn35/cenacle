// SPDX-License-Identifier: Apache-2.0

package httpx

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"net/http"
	"regexp"
)

// RequestIDHeader carries the request ID in both directions.
const RequestIDHeader = "X-Request-ID"

type ctxKey struct{}

// Incoming IDs from a trusted proxy are reused only if they look sane, so
// that arbitrary client input never ends up in logs or responses verbatim.
var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)

var idEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewRequestID returns a random, URL-safe, upper-case request ID.
func NewRequestID() string {
	var b [10]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never returns an error.
	return "REQ-" + idEncoding.EncodeToString(b[:])
}

// RequestID assigns every request an ID, stores it in the context and
// echoes it in the response header.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if !validRequestID.MatchString(id) {
			id = NewRequestID()
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

// RequestIDFrom returns the request ID stored by RequestID, or "".
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}
