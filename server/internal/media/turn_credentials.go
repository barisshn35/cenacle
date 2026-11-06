// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

func turnMAC(secret, message string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(message))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func TURNServerCredentials(secret string, urls []string, participant string, now time.Time) (ICEServer, error) {
	if len(secret) < 32 {
		return ICEServer{}, errors.New("TURN credentials unavailable")
	}
	if id, err := uuid.Parse(participant); err != nil || id == uuid.Nil {
		return ICEServer{}, ErrAdmission
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return ICEServer{}, errors.New("TURN credentials unavailable")
	}
	core := strconv.FormatInt(now.Add(10*time.Minute).Unix(), 10) + ":" + participant + ":" + base64.RawURLEncoding.EncodeToString(random)
	username := core + ":" + turnMAC(secret, core)
	return ICEServer{URLs: urls, Username: username, Credential: turnMAC(secret, "turn-password:"+username)}, nil
}
func verifyTURNUsername(secret, username string, now time.Time) (string, bool, bool) {
	if len(username) > 256 || len(secret) < 32 {
		return "", false, false
	}
	parts := strings.Split(username, ":")
	if len(parts) != 4 {
		return "", false, false
	}
	core := strings.Join(parts[:3], ":")
	if !hmac.Equal([]byte(parts[3]), []byte(turnMAC(secret, core))) {
		return "", false, false
	}
	expires, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || expires > now.Unix()+605 {
		return "", false, false
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || id == uuid.Nil {
		return "", false, false
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(nonce) != 16 {
		return "", false, false
	}
	return parts[1], expires > now.Unix(), true
}
