// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"time"

	"github.com/barisshn35/cenacle/server/internal/httpx"
)

// DesktopSignedInPath is where a desktop sign-in ends: the app's window stops
// there and takes the code from the address.
const DesktopSignedInPath = "/desktop/signed-in"

// handOverTTL bounds how long the code of a desktop sign-in can be exchanged.
const handOverTTL = time.Minute

// desktopChallenge is an S256 PKCE challenge: 32 bytes, base64url.
var desktopChallenge = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func handOverKey(code string) string { return "cenacle:auth:desktop:" + code }

// handOver is what waits for the desktop app between its window and its
// exchange of the code.
type handOver struct {
	Token     string    `json:"token"`
	Challenge string    `json:"challenge"`
	ExpiresAt time.Time `json:"expires_at"`
}

// handOver keeps the session of a desktop sign-in under a one-time code.
func (h *Handlers) handOver(ctx context.Context, s signedIn, challenge string) (string, error) {
	code := randomString()
	value, _ := json.Marshal(handOver{Token: s.token, Challenge: challenge, ExpiresAt: s.session.ExpiresAt})
	if err := h.Flows.PutNew(ctx, handOverKey(code), value, handOverTTL); err != nil {
		return "", err
	}
	return code, nil
}

// DesktopToken implements api.ServerInterface: the session of a desktop
// sign-in, for its one-time code and the verifier of its challenge.
func (h *Handlers) DesktopToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code     string `json:"code"`
		Verifier string `json:"verifier"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || in.Code == "" || len(in.Verifier) < 43 || len(in.Verifier) > 128 {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "code and verifier are required."})
		return
	}
	invalid := func() {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: "invalid_code",
			Detail: "The code is unknown, used or expired. Sign in again."})
	}
	raw, err := h.Flows.Take(r.Context(), handOverKey(in.Code))
	if err != nil {
		invalid()
		return
	}
	var ho handOver
	if err := json.Unmarshal(raw, &ho); err != nil {
		invalid()
		return
	}
	sum := sha256.Sum256([]byte(in.Verifier))
	if subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(ho.Challenge)) != 1 {
		// The code is used up either way: whoever saw it cannot try again.
		invalid()
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}{ho.Token, ho.ExpiresAt})
}
