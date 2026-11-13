// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"context"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

type savedServer store.GetMailServerRow

func (s savedServer) GetMailServer(context.Context) (store.GetMailServerRow, error) {
	return store.GetMailServerRow(s), nil
}

// The server's own settings win; else the saved server, read on each use.
func TestRelays(t *testing.T) {
	ctx := context.Background()
	if s, err := (&Relays{Store: savedServer{}}).Relay(ctx); err != nil || s != nil {
		t.Errorf("nothing saved = %+v, %v", s, err)
	}
	saved := savedServer{SmtpHost: "mail.example.com", SmtpPort: 465, SmtpSecurity: "tls",
		SmtpUsername: "toplanti@example.com", SmtpPassword: "p", SmtpFrom: "Cenacle <toplanti@example.com>"}
	s, err := (&Relays{Store: saved}).Relay(ctx)
	if err != nil || s == nil || s.Host != "mail.example.com" || s.Port != 465 || s.Security != "tls" || s.Password != "p" || s.From != saved.SmtpFrom {
		t.Errorf("saved = %+v, %v", s, err)
	}
	fixed := &SMTP{Host: "relay.internal"}
	if s, _ := (&Relays{Fixed: fixed, Store: saved}).Relay(ctx); s != fixed {
		t.Errorf("fixed = %+v", s)
	}
}

// Replies to an invitation go to the organizer, not the sending account.
func TestMeetingMailRepliesToTheOrganizer(t *testing.T) {
	start := time.Date(2026, 12, 4, 7, 0, 0, 0, time.UTC)
	m, err := RenderMeetingMail(MeetingMail{
		Kind: "invite", MeetingID: "m-1", Title: "Release review", Organizer: "Deniz Kaya", OrganizerEmail: "deniz@example.com",
		Workspace: "Cenacle", Start: start, End: start.Add(time.Hour), TimeZone: "UTC", PlaceKind: "standard", PlaceName: "General",
		People: []string{"Deniz Kaya"}, PeopleTotal: 1, Language: "en", RecipientTZ: "UTC", RecipientName: "Mert",
		RecipientEmail: "mert@example.com", PublicURL: "https://chat.example.com", From: "Cenacle <toplanti@example.com>",
	}, start.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	from, _ := mail.ParseAddress("Cenacle <toplanti@example.com>")
	to, _ := mail.ParseAddress(m.To)
	raw, err := m.message(from, to, start)
	if err != nil {
		t.Fatal(err)
	}
	head := string(raw[:strings.Index(string(raw), "\r\n\r\n")])
	if !strings.Contains(head, "Reply-To: <deniz@example.com>") || !strings.Contains(head, "From: \"Cenacle\" <toplanti@example.com>") {
		t.Errorf("headers:\n%s", head)
	}
	m.ReplyTo = ""
	raw, _ = m.message(from, to, start)
	if strings.Contains(string(raw), "Reply-To:") {
		t.Error("Reply-To without an organizer address")
	}
}
