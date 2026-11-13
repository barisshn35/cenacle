// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"context"

	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// MailRelay gives the mail server to send e-mail through, or nil when the
// installation sends none.
type MailRelay interface {
	Relay(ctx context.Context) (*SMTP, error)
}

// Relay implements MailRelay for a fixed mail server.
func (s *SMTP) Relay(context.Context) (*SMTP, error) { return s, nil }

// MailServerStore reads the mail server administrators saved.
type MailServerStore interface {
	GetMailServer(ctx context.Context) (store.GetMailServerRow, error)
}

// Relays is the installation's mail server: the server's own settings
// (CENACLE_SMTP_*) when it has them, else the one administrators set in the
// app, read on each use so a change applies at once.
type Relays struct {
	Fixed *SMTP
	Store MailServerStore
}

// Relay implements MailRelay.
func (r *Relays) Relay(ctx context.Context) (*SMTP, error) {
	if r.Fixed != nil {
		return r.Fixed, nil
	}
	s, err := r.Store.GetMailServer(ctx)
	if err != nil || s.SmtpHost == "" {
		return nil, err
	}
	return &SMTP{
		Host: s.SmtpHost, Port: int(s.SmtpPort), Security: s.SmtpSecurity,
		Username: s.SmtpUsername, Password: s.SmtpPassword, From: s.SmtpFrom,
	}, nil
}
