// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/barisshn35/cenacle/server/internal/egress"
)

// --- e-mail ------------------------------------------------------------------

// SMTP sends e-mail through a relay.
type SMTP struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	// Security is starttls, tls or none.
	Security string
	Timeout  time.Duration
}

// Mail is one message to send (plain text).
type Mail struct {
	To      string
	Subject string
	Text    string
}

func headerValue(s string) string { return mime.QEncoding.Encode("utf-8", s) }

// Send delivers a message (one recipient).
func (s *SMTP) Send(ctx context.Context, m Mail) error {
	from, err := mail.ParseAddress(s.From)
	if err != nil {
		return fmt.Errorf("smtp: from: %w", err)
	}
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("smtp: to: %w", err)
	}
	var body bytes.Buffer
	fmt.Fprintf(&body, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\n",
		from.String(), to.String(), headerValue(m.Subject), time.Now().UTC().Format(time.RFC1123Z))
	body.WriteString("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n")
	body.WriteString("Auto-Submitted: auto-generated\r\n\r\n")
	qp := quotedprintable.NewWriter(&body)
	if _, err := qp.Write([]byte(strings.ReplaceAll(m.Text, "\n", "\r\n"))); err != nil {
		return err
	}
	_ = qp.Close()

	timeout := s.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	addr := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	dialer := &net.Dialer{Timeout: timeout}
	var conn net.Conn
	if s.Security == "tls" {
		td := &tls.Dialer{NetDialer: dialer, Config: &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}}
		conn, err = td.DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp: connect: %w", err)
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtp: %w", err)
	}
	defer func() { _ = c.Close() }()
	if s.Security == "starttls" {
		if err := c.StartTLS(&tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("smtp: starttls: %w", err)
		}
	}
	if s.Username != "" {
		// PlainAuth refuses to send the password without TLS (except to localhost).
		if err := c.Auth(smtp.PlainAuth("", s.Username, s.Password, s.Host)); err != nil {
			return fmt.Errorf("smtp: auth: %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return fmt.Errorf("smtp: mail from: %w", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return fmt.Errorf("smtp: rcpt: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp: data: %w", err)
	}
	if _, err := w.Write(body.Bytes()); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp: data: %w", err)
	}
	return c.Quit()
}

// --- web push ------------------------------------------------------------------

// ErrGone: the push service no longer knows the subscription (remove it).
var ErrGone = errors.New("push: subscription gone")

// Push sends web push notifications through the browsers' push services, over
// the SSRF-protected egress client (endpoints come from browsers).
type Push struct {
	Egress     *egress.Client
	Subscriber string // mailto: or https: contact
	PublicKey  string
	PrivateKey string
}

// PushEgress is the client for push endpoints. Any browser names its
// endpoint, so like link previews it has no allow list (the operator's
// internal networks are for bots) and speaks https only.
func PushEgress() *egress.Client {
	return egress.New(egress.Policy{Timeout: pushTimeout, MaxResponse: 64 << 10})
}

// pushTimeout bounds one delivery to a push service (they answer well within
// it): a stalled one holds up one push worker no longer.
const pushTimeout = 5 * time.Second

// Payload is what the service worker shows.
type Payload struct {
	Title     string `json:"title"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	Tag       string `json:"tag"`
	ChannelID string `json:"channel_id"`
}

// egressDoer adapts the egress client to webpush's HTTP client.
type egressDoer struct{ c *egress.Client }

func (d egressDoer) Do(req *http.Request) (*http.Response, error) {
	if _, err := d.c.CheckURL(req.URL.String()); err != nil {
		return nil, err
	}
	res, err := d.c.Do(req)
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: res.Status, Status: http.StatusText(res.Status),
		Body: io.NopCloser(bytes.NewReader(res.Body)), Header: http.Header{}, Request: req,
	}, nil
}

// Send delivers one notification to one subscription.
func (p *Push) Send(ctx context.Context, endpoint, p256dh, auth string, payload Payload) error {
	msg, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	res, err := webpush.SendNotificationWithContext(ctx, msg, &webpush.Subscription{
		Endpoint: endpoint, Keys: webpush.Keys{P256dh: p256dh, Auth: auth},
	}, &webpush.Options{
		HTTPClient: egressDoer{p.Egress}, Subscriber: p.Subscriber, TTL: 3600, Urgency: webpush.UrgencyHigh,
		Topic: topic(payload.Tag), VAPIDPublicKey: p.PublicKey, VAPIDPrivateKey: p.PrivateKey,
	})
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
		return ErrGone
	case res.StatusCode >= 300:
		return fmt.Errorf("push: status %d", res.StatusCode)
	}
	return nil
}

// topic collapses notifications of one channel at the push service (at most
// 32 URL-safe characters).
func topic(tag string) string {
	var b strings.Builder
	for _, r := range tag {
		if b.Len() == 32 {
			break
		}
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// GenerateKeys makes a VAPID key pair (base64url).
func GenerateKeys() (public, private string, err error) {
	private, public, err = webpush.GenerateVAPIDKeys()
	return public, private, err
}
