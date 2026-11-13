// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/notify"
)

// Administrators set the outgoing mail server in the app; its password is
// never shown again, and e-mail goes through it at once.
func TestMailServer(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("mail-a", "Ayşe")
	const path = "/api/admin/mail-server"

	if res := s.call(http.MethodGet, path, ayse, nil, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("member reads it = %d", res.StatusCode)
	}
	var got api.MailServer
	if res := s.call(http.MethodGet, path, admin, nil, &got); res.StatusCode != http.StatusOK || got.Host != "" || *got.Managed || *got.HasPassword {
		t.Fatalf("unset = %d %+v", res.StatusCode, got)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/admin/test-email", admin, nil); status != http.StatusConflict || code != "email_unavailable" {
		t.Errorf("test e-mail without a server = %d %s", status, code)
	}

	for name, in := range map[string]map[string]any{
		"a URL":               {"host": "https://mail.example.com", "port": 587, "security": "starttls", "username": "", "from": "a@example.com"},
		"a port in the host":  {"host": "mail.example.com:587", "port": 587, "security": "starttls", "username": "", "from": "a@example.com"},
		"no port":             {"host": "mail.example.com", "port": 0, "security": "starttls", "username": "", "from": "a@example.com"},
		"a password in clear": {"host": "mail.example.com", "port": 25, "security": "none", "username": "toplanti@example.com", "password": "x", "from": "a@example.com"},
		"no sender":           {"host": "mail.example.com", "port": 587, "security": "starttls", "username": "", "from": "Cenacle"},
		"an unknown security": {"host": "mail.example.com", "port": 587, "security": "ssl", "username": "", "from": "a@example.com"},
	} {
		if status, _ := problemCode(t, s, http.MethodPut, path, admin, in); status != http.StatusBadRequest {
			t.Errorf("%s = %d", name, status)
		}
	}
	if res := s.call(http.MethodPut, path, ayse, map[string]any{"host": "", "port": 587, "security": "starttls", "username": "", "from": ""}, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("member sets it = %d", res.StatusCode)
	}

	// An account with a password: kept when not sent again, never shown.
	account := map[string]any{"host": "mail.example.com", "port": 587, "security": "starttls",
		"username": "toplanti@example.com", "password": "s3cret-pass", "from": "Cenacle <toplanti@example.com>"}
	res := s.call(http.MethodPut, path, admin, account, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("set = %d", res.StatusCode)
	}
	delete(account, "password")
	if res := s.call(http.MethodPut, path, admin, account, &got); res.StatusCode != http.StatusOK || !*got.HasPassword || got.Username != "toplanti@example.com" {
		t.Errorf("password not kept: %d %+v", res.StatusCode, got)
	}
	status, _, body := s.get(admin, path)
	if status != http.StatusOK || strings.Contains(string(body), "s3cret") || strings.Contains(string(body), `"password"`) {
		t.Errorf("read = %d %s", status, body)
	}
	var trail string
	if err := s.pool.QueryRow(context.Background(),
		"SELECT string_agg(detail::text, ' ') FROM audit_events WHERE action = 'instance.mail_server_changed'").Scan(&trail); err != nil {
		t.Fatal(err)
	}
	if strings.Count(trail, "toplanti@example.com") < 2 || strings.Contains(trail, "s3cret") {
		t.Errorf("audit trail: %s", trail)
	}

	// A relay inside the network, no account: the password goes too.
	smtpd := newFakeSMTP(t)
	_, port, _ := net.SplitHostPort(smtpd.ln.Addr().String())
	if res := s.call(http.MethodPut, path, admin, map[string]any{"host": "127.0.0.1", "port": atoi(t, port), "security": "none",
		"username": "", "from": "Cenacle <toplanti@example.com>"}, &got); res.StatusCode != http.StatusOK || *got.HasPassword {
		t.Fatalf("relay = %d %+v", res.StatusCode, got)
	}
	if res := s.call(http.MethodPost, "/api/admin/test-email", admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("test e-mail = %d", res.StatusCode)
	}
	smtpd.mu.Lock()
	mails := strings.Join(smtpd.mail, "\n")
	smtpd.mu.Unlock()
	if !strings.Contains(mails, "From: \"Cenacle\" <toplanti@example.com>") || !strings.Contains(mails, adminEmail) {
		t.Errorf("sample invitation:\n%s", mails)
	}
	var settings api.NotificationSettings
	if s.call(http.MethodGet, "/api/me/notifications", ayse, nil, &settings); !settings.EmailAvailable {
		t.Error("e-mail not offered to people")
	}

	// Off again.
	if res := s.call(http.MethodPut, path, admin, map[string]any{"host": "", "port": 1, "security": "none", "username": "", "from": ""}, &got); res.StatusCode != http.StatusOK || got.Host != "" || got.Port != 587 {
		t.Errorf("off = %d %+v", res.StatusCode, got)
	}
}

// A mail server the server's own settings name is shown, not changed.
func TestMailServerManaged(t *testing.T) {
	fixed := &notify.SMTP{Host: "mail.internal", Port: 25, Security: "none", From: "Cenacle <chat@example.com>"}
	s := newStack(t, newShared(t), options{mailManaged: fixed})
	admin := s.admin()
	var got api.MailServer
	if res := s.call(http.MethodGet, "/api/admin/mail-server", admin, nil, &got); res.StatusCode != http.StatusOK || !*got.Managed || got.Host != "mail.internal" {
		t.Fatalf("managed = %d %+v", res.StatusCode, got)
	}
	status, code := problemCode(t, s, http.MethodPut, "/api/admin/mail-server", admin,
		map[string]any{"host": "other.example.com", "port": 587, "security": "starttls", "username": "", "from": "a@example.com"})
	if status != http.StatusConflict || code != "mail_server_managed" {
		t.Errorf("change = %d %s", status, code)
	}
}
