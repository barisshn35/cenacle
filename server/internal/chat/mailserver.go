// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"net"
	"net/http"
	"net/mail"
	"strings"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// emailAvailable: the installation has a mail server to send e-mail through.
func (h *Handlers) emailAvailable(ctx context.Context) bool {
	if h.Mail == nil {
		return false
	}
	s, err := h.Mail.Relay(ctx)
	return err == nil && s != nil
}

func (h *Handlers) mailServerAPI(w http.ResponseWriter, r *http.Request) {
	if h.MailManaged != nil {
		m := h.MailManaged
		httpx.WriteJSON(w, http.StatusOK, api.MailServer{Host: m.Host, Port: m.Port, Security: api.MailServerSecurity(m.Security),
			Username: m.Username, HasPassword: ptr(m.Password != ""), From: m.From, Managed: ptr(true)})
		return
	}
	s, err := h.Queries.GetMailServer(r.Context())
	if err != nil {
		h.unavailable(w, r, "get mail server", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.MailServer{Host: s.SmtpHost, Port: int(s.SmtpPort), Security: api.MailServerSecurity(s.SmtpSecurity),
		Username: s.SmtpUsername, HasPassword: ptr(s.SmtpPassword != ""), From: s.SmtpFrom, Managed: ptr(false)})
}

// GetMailServer implements api.ServerInterface.
func (h *Handlers) GetMailServer(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if ok && requireInstanceAdmin(w, r, p) {
		h.mailServerAPI(w, r)
	}
}

// cleanMailServer checks what an administrator entered; problem says what is wrong.
func cleanMailServer(in api.MailServer) (host, username, from, problem string) {
	host = strings.TrimSpace(in.Host)
	username = strings.TrimSpace(in.Username)
	from = strings.TrimSpace(in.From)
	if host == "" {
		return "", "", "", "" // e-mail off
	}
	if len(host) > 253 || strings.ContainsAny(host, " /:@") && net.ParseIP(host) == nil {
		return "", "", "", "The server is a name or an address, without a port or https://."
	}
	if in.Port < 1 || in.Port > 65535 {
		return "", "", "", "The port is a number from 1 to 65535."
	}
	switch in.Security {
	case api.MailServerSecurityStarttls, api.MailServerSecurityTls:
	case api.MailServerSecurityNone:
		if username != "" {
			return "", "", "", "A user name needs STARTTLS or TLS: the password must not travel unencrypted."
		}
	default:
		return "", "", "", "security is starttls, tls or none."
	}
	if len(username) > 320 {
		return "", "", "", "The user name has up to 320 characters."
	}
	if a, err := mail.ParseAddress(from); err != nil || len(from) > 400 || !strings.Contains(a.Address, "@") {
		return "", "", "", "The sender is an e-mail address, like Cenacle <meetings@example.com>."
	}
	return host, username, from, ""
}

// SetMailServer implements api.ServerInterface.
func (h *Handlers) SetMailServer(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	if h.MailManaged != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "mail_server_managed",
			Detail: "The server's own settings (CENACLE_SMTP_HOST) name the mail server; change it there."})
		return
	}
	var in api.MailServer
	if !decode(w, r, &in) {
		return
	}
	host, username, from, problem := cleanMailServer(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	current, err := h.Queries.GetMailServer(r.Context())
	if err != nil {
		h.unavailable(w, r, "get mail server", err)
		return
	}
	password := current.SmtpPassword
	if in.Password != nil && *in.Password != "" {
		if len(*in.Password) > 500 {
			badRequest(w, r, "The password has up to 500 characters.")
			return
		}
		password = *in.Password
	}
	if username == "" {
		password = "" // no account: no password kept
	}
	port, security := in.Port, string(in.Security)
	if host == "" {
		port, security, password = 587, "starttls", ""
	}
	if err := h.Queries.SetMailServer(r.Context(), store.SetMailServerParams{
		Host: host, Port: int32(port), Security: security, Username: username, Password: password, Sender: from, //nolint:gosec // port is checked above
	}); err != nil {
		h.unavailable(w, r, "set mail server", err)
		return
	}
	// What changed, never the password itself.
	h.Audit.Record(r.Context(), audit.Event{Actor: p.User.ID, Action: audit.MailServerChanged, IP: p.IP,
		Detail: map[string]any{"host": host, "port": port, "security": security, "username": username, "from": from,
			"password_changed": password != current.SmtpPassword}})
	h.mailServerAPI(w, r)
}
