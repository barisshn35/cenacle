// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

// Control contains no signaling data. Each request is signed independently and
// has a bounded replay window; the media key cannot sign admission tokens.
type Control struct {
	Grant
	ID                  string `json:"jti"`
	Audience            string `json:"aud"`
	At                  int64  `json:"iat"`
	Action              string `json:"action"`
	TransportGeneration int64  `json:"transport_generation"`
}
type AdmissionPolicy struct {
	Allowed         bool `json:"allowed"`
	MaxBitrate      int  `json:"max_bitrate"`
	MaxParticipants int  `json:"max_participants"`
}

func SignControl(private ed25519.PrivateKey, c Control) (string, error) {
	if len(private) != ed25519.PrivateKeySize {
		return "", errors.New("invalid media control key")
	}
	c.ID = uuid.NewString()
	c.At = time.Now().Unix()
	c.Audience = "cenacle-chat-media-control"
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: private}, (&jose.SignerOptions{}).WithType("cenacle-media-control+jwt"))
	if err != nil {
		return "", errors.New("media control signing failed")
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", errors.New("media control encoding failed")
	}
	signed, err := signer.Sign(raw)
	if err != nil {
		return "", errors.New("media control signing failed")
	}
	return signed.CompactSerialize()
}
func VerifyControl(public ed25519.PublicKey, raw string, now time.Time) (Control, error) {
	var c Control
	if len(raw) > 8192 || strings.Count(raw, ".") != 2 || len(public) != ed25519.PublicKeySize {
		return c, ErrAdmission
	}
	signed, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.EdDSA})
	if err != nil || len(signed.Signatures) != 1 {
		return c, ErrAdmission
	}
	h := signed.Signatures[0].Protected
	if h.ExtraHeaders[jose.HeaderType] != "cenacle-media-control+jwt" {
		return c, ErrAdmission
	}
	payload, err := signed.Verify(public)
	if err != nil || decodeStrict(payload, &c) != nil {
		return Control{}, ErrAdmission
	}
	if (c.Action != "health" && (!validGrant(c.Grant) || c.TransportGeneration < 1)) || c.Audience != "cenacle-chat-media-control" || c.At > now.Unix()+5 || c.At < now.Unix()-30 {
		return Control{}, ErrAdmission
	}
	id, err := uuid.Parse(c.ID)
	if err != nil || id == uuid.Nil {
		return Control{}, ErrAdmission
	}
	switch c.Action {
	case "health", "authorize", "joined", "disconnected", "left":
	default:
		return Control{}, ErrAdmission
	}
	return c, nil
}

// ControlClient only sends to the fixed operator-configured internal endpoint.
// It refuses redirects, which must never receive a signed control request.
type ControlClient struct {
	URL     string
	Private ed25519.PrivateKey
	HTTP    *http.Client
}

func (c *ControlClient) Check(ctx context.Context) error {
	_, err := c.Send(ctx, Control{Action: "health"})
	return err
}

var internalControlTransport = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	return t
}()

func (c *ControlClient) Send(ctx context.Context, control Control) (AdmissionPolicy, error) {
	signed, err := SignControl(c.Private, control)
	if err != nil {
		return AdmissionPolicy{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewBufferString(signed)) //nolint:gosec // the operator's configured control URL
	if err != nil {
		return AdmissionPolicy{}, errors.New("invalid media control URL")
	}
	request.Header.Set("Content-Type", "application/jose")
	var transport http.RoundTripper = internalControlTransport
	if c.HTTP != nil && c.HTTP.Transport != nil {
		transport = c.HTTP.Transport
	}
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request) //nolint:gosec // the operator's configured control URL
	if err != nil {
		return AdmissionPolicy{}, errors.New("media authorization unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode >= http.StatusInternalServerError {
		return AdmissionPolicy{}, errors.New("media authorization unavailable")
	}
	if response.StatusCode != http.StatusOK {
		return AdmissionPolicy{}, ErrAdmission
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return AdmissionPolicy{}, ErrAdmission
	}
	var policy AdmissionPolicy
	if decodeStrict(raw, &policy) != nil || !policy.Allowed {
		return AdmissionPolicy{}, ErrAdmission
	}
	if policy.MaxParticipants < 2 || policy.MaxParticipants > MaxParticipantsCap || policy.MaxBitrate < 64000 || policy.MaxBitrate > 10000000 {
		return AdmissionPolicy{}, ErrAdmission
	}
	return policy, nil
}
