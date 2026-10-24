// SPDX-License-Identifier: Apache-2.0

package cenacle

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// SignatureHeader carries the signature of every request Cenacle sends to a bot.
const SignatureHeader = "X-Cenacle-Signature"

// MaxAge is how old a signed request may be.
const MaxAge = 5 * time.Minute

func mac(secret string, ts int64, body []byte) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(strconv.FormatInt(ts, 10)))
	h.Write([]byte("."))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// Sign returns the signature header value of a body at a time (for tests of bots).
func Sign(secret string, at time.Time, body []byte) string {
	ts := at.Unix()
	return "t=" + strconv.FormatInt(ts, 10) + ",v1=" + mac(secret, ts, body)
}

// Verify checks a signature header against the raw body: the HMAC-SHA256 of
// "<t>.<body>" with the secret, from no more than MaxAge ago.
func Verify(secret, header string, body []byte, now time.Time) bool {
	var ts int64
	var sig string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts, _ = strconv.ParseInt(v, 10, 64)
		case "v1":
			sig = v
		}
	}
	if ts == 0 || sig == "" {
		return false
	}
	age := now.Sub(time.Unix(ts, 0))
	if age > MaxAge || age < -MaxAge {
		return false
	}
	return hmac.Equal([]byte(mac(secret, ts, body)), []byte(sig))
}
