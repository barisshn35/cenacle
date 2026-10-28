// SPDX-License-Identifier: AGPL-3.0-only

// Package signing signs requests Cenacle sends to bots (slash commands, event
// subscriptions) so they can tell them from forgeries:
//
//	X-Cenacle-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
//
// Bots recompute the HMAC with their secret and reject old timestamps.
package signing

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// Header carries the signature.
const Header = "X-Cenacle-Signature"

// NewSecret returns a random signing secret (256 bits).
func NewSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return "cns_" + base64.RawURLEncoding.EncodeToString(b)
}

func mac(secret string, ts int64, body []byte) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(strconv.FormatInt(ts, 10) + "."))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// Sign returns the header value for a body at a time.
func Sign(secret string, at time.Time, body []byte) string {
	ts := at.Unix()
	return "t=" + strconv.FormatInt(ts, 10) + ",v1=" + mac(secret, ts, body)
}

// Parse returns a header value's time (unix seconds) and v1 signature; 0 and
// "" when missing.
func Parse(header string) (int64, string) {
	var ts int64
	var sig string
	for _, part := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(part, "=")
		switch k {
		case "t":
			ts, _ = strconv.ParseInt(v, 10, 64)
		case "v1":
			sig = v
		}
	}
	return ts, sig
}

// Verify checks a header value (for bots written in Go and for tests).
func Verify(secret, header string, body []byte, now time.Time, tolerance time.Duration) bool {
	ts, sig := Parse(header)
	if ts == 0 || sig == "" {
		return false
	}
	if d := now.Sub(time.Unix(ts, 0)); d > tolerance || d < -tolerance {
		return false
	}
	return hmac.Equal([]byte(sig), []byte(mac(secret, ts, body)))
}
