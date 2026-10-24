// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// auditLine is one event of the installation's audit log as exported and
// streamed: stable field names for SIEM parsers.
type auditLine struct {
	ID            string         `json:"id"`
	At            time.Time      `json:"at"`
	Action        string         `json:"action"`
	ActorID       string         `json:"actor_id,omitempty"`
	ActorName     string         `json:"actor_name,omitempty"`
	WorkspaceID   string         `json:"workspace_id,omitempty"`
	WorkspaceName string         `json:"workspace_name,omitempty"`
	TargetType    string         `json:"target_type,omitempty"`
	TargetID      string         `json:"target_id,omitempty"`
	IPAddress     string         `json:"ip_address,omitempty"`
	Detail        map[string]any `json:"detail"`
	Server        string         `json:"server"`
}

func (h *Handlers) auditLineOf(e store.AuditEvent, actor, workspace string) auditLine {
	return newAuditLine(e, actor, workspace, h.PublicURL)
}

func newAuditLine(e store.AuditEvent, actor, workspace, server string) auditLine {
	l := auditLine{ID: uuid(e.ID).String(), At: e.At, Action: e.Action, ActorName: actor, WorkspaceName: workspace,
		TargetType: e.TargetType, TargetID: e.TargetID, IPAddress: e.IpAddress, Detail: map[string]any{}, Server: serverHost(server)}
	if e.ActorID.Valid {
		l.ActorID = uuid(e.ActorID).String()
	}
	if e.WorkspaceID.Valid {
		l.WorkspaceID = uuid(e.WorkspaceID).String()
	}
	_ = json.Unmarshal(e.Detail, &l.Detail)
	return l
}

func auditEventAPI(e store.AuditEvent, actor, workspace string) api.AuditEvent {
	ev := api.AuditEvent{Id: uuid(e.ID), At: e.At, Action: e.Action, TargetType: e.TargetType, TargetId: e.TargetID,
		Detail: map[string]any{}, IpAddress: ptr(e.IpAddress)}
	_ = json.Unmarshal(e.Detail, &ev.Detail)
	if e.ActorID.Valid {
		ev.Actor = &struct {
			DisplayName string             `json:"display_name"`
			Id          openapi_types.UUID `json:"id"`
		}{DisplayName: actor, Id: uuid(e.ActorID)}
	}
	if e.WorkspaceID.Valid {
		ev.Workspace = &struct {
			Id   openapi_types.UUID `json:"id"`
			Name string             `json:"name"`
		}{Id: uuid(e.WorkspaceID), Name: workspace}
	}
	return ev
}

func instanceAuditParams(prefix *string, actor, workspace, before *openapi_types.UUID, since, until *time.Time, limit int) (store.ListInstanceAuditParams, string) {
	p := strings.TrimSpace(deref1(prefix))
	if len(p) > 60 {
		return store.ListInstanceAuditParams{}, "prefix has up to 60 characters."
	}
	if limit < 1 || limit > 200 {
		return store.ListInstanceAuditParams{}, "limit must be between 1 and 200."
	}
	return store.ListInstanceAuditParams{
		Before: optUUID((*[16]byte)(before)), ActionPrefix: p, ActorID: optUUID((*[16]byte)(actor)), WorkspaceID: optUUID((*[16]byte)(workspace)),
		Since: tsOf(since), Until: tsOf(until), RowLimit: int32(limit + 1), //nolint:gosec // 2..201
	}, ""
}

// ListInstanceAudit implements api.ServerInterface.
func (h *Handlers) ListInstanceAudit(w http.ResponseWriter, r *http.Request, params api.ListInstanceAuditParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	arg, problem := instanceAuditParams(params.Prefix, params.ActorId, params.WorkspaceId, params.Before, params.Since, params.Until, limit)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	rows, err := h.Queries.ListInstanceAudit(r.Context(), arg)
	if err != nil {
		h.unavailable(w, r, "list audit events", err)
		return
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	out := make([]api.AuditEvent, 0, len(rows))
	for _, e := range rows {
		out = append(out, auditEventAPI(store.AuditEvent{ID: e.ID, At: e.At, ActorID: e.ActorID, WorkspaceID: e.WorkspaceID,
			Action: e.Action, TargetType: e.TargetType, TargetID: e.TargetID, IpAddress: e.IpAddress, Detail: e.Detail}, e.ActorName, e.WorkspaceName))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Events  []api.AuditEvent `json:"events"`
		HasMore bool             `json:"has_more"`
	}{out, more})
}

// ExportInstanceAudit implements api.ServerInterface.
func (h *Handlers) ExportInstanceAudit(w http.ResponseWriter, r *http.Request, params api.ExportInstanceAuditParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	const page = 500
	arg, problem := instanceAuditParams(params.Prefix, params.ActorId, params.WorkspaceId, params.Before, params.Since, params.Until, 1)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	arg.RowLimit = page
	// The export is itself an event (written before, so it is in the file).
	h.Audit.Record(r.Context(), audit.Event{Actor: p.User.ID, Action: audit.AuditExported, IP: p.IP,
		Detail: map[string]any{"prefix": arg.ActionPrefix, "since": params.Since, "until": params.Until}})
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="cenacle-audit.ndjson"`)
	w.Header().Set("Cache-Control", "no-store")
	out := bufio.NewWriter(w)
	enc := json.NewEncoder(out)
	wrote := false
	for {
		rows, err := h.Queries.ListInstanceAudit(r.Context(), arg)
		if err != nil {
			if !wrote {
				h.unavailable(w, r, "export audit events", err)
			} else {
				h.Log.ErrorContext(r.Context(), "export audit events", slog.Any("error", err))
			}
			return
		}
		for _, e := range rows {
			if err := enc.Encode(h.auditLineOf(store.AuditEvent{ID: e.ID, At: e.At, ActorID: e.ActorID, WorkspaceID: e.WorkspaceID,
				Action: e.Action, TargetType: e.TargetType, TargetID: e.TargetID, IpAddress: e.IpAddress, Detail: e.Detail},
				e.ActorName, e.WorkspaceName)); err != nil {
				return
			}
			wrote = true
		}
		if len(rows) < page {
			break
		}
		arg.Before = rows[len(rows)-1].ID
		if err := out.Flush(); err != nil {
			return
		}
	}
	_ = out.Flush()
}

func (h *Handlers) auditStreamAPI(w http.ResponseWriter, r *http.Request) {
	s, err := h.Queries.GetAuditStream(r.Context())
	if err != nil {
		h.unavailable(w, r, "get audit stream", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.AuditStream{Kind: api.AuditStreamKind(s.AuditStreamKind), Address: s.AuditStreamAddress,
		Tls: s.AuditStreamTls, HasSecret: ptr(s.AuditStreamSecret != ""), LastError: ptr(s.AuditStreamError),
		LastSentAt: timeOf(s.AuditStreamSentAt)})
}

// GetAuditStream implements api.ServerInterface.
func (h *Handlers) GetAuditStream(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if ok && requireInstanceAdmin(w, r, p) {
		h.auditStreamAPI(w, r)
	}
}

// cleanStreamAddress checks a stream's address: an https URL (http://
// only where the egress policy allows it) or host:port for syslog.
func (h *Handlers) cleanStreamAddress(kind api.AuditStreamKind, address string) (string, string) {
	address = strings.TrimSpace(address)
	switch kind {
	case api.AuditStreamKindNone:
		return "", ""
	case api.AuditStreamKindHttp:
		if h.Egress == nil {
			return "", "This server cannot reach others."
		}
		if _, err := h.Egress.CheckURL(address); err != nil {
			return "", "The address must be an https URL."
		}
	case api.AuditStreamKindSyslog:
		host, port, err := net.SplitHostPort(address)
		if err != nil || host == "" || port == "" {
			return "", "The address is host:port."
		}
	default:
		return "", "kind is none, http or syslog."
	}
	return address, ""
}

// SetAuditStream implements api.ServerInterface.
func (h *Handlers) SetAuditStream(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	var in api.AuditStream
	if !decode(w, r, &in) {
		return
	}
	address, problem := h.cleanStreamAddress(in.Kind, in.Address)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	current, err := h.Queries.GetAuditStream(r.Context())
	if err != nil {
		h.unavailable(w, r, "get audit stream", err)
		return
	}
	secret := current.AuditStreamSecret
	if in.Secret != nil && *in.Secret != "" {
		if len(*in.Secret) > 200 {
			badRequest(w, r, "The secret has up to 200 characters.")
			return
		}
		secret = *in.Secret
	}
	// Turning it on (or pointing it elsewhere) starts with what is written from now.
	cursor := current.AuditStreamCursor
	if in.Kind == api.AuditStreamKindNone {
		cursor = pgtype.UUID{}
	} else if !cursor.Valid || current.AuditStreamKind != string(in.Kind) || current.AuditStreamAddress != address {
		if cursor, err = h.Queries.LatestAuditEventID(r.Context()); err != nil {
			h.unavailable(w, r, "audit cursor", err)
			return
		}
	}
	if err := h.Queries.SetAuditStream(r.Context(), store.SetAuditStreamParams{
		Kind: string(in.Kind), Address: address, Secret: secret, Tls: in.Tls, Cursor: cursor,
	}); err != nil {
		h.unavailable(w, r, "set audit stream", err)
		return
	}
	h.Audit.Record(r.Context(), audit.Event{Actor: p.User.ID, Action: audit.AuditStreamChanged, IP: p.IP,
		Detail: map[string]any{"kind": in.Kind, "address": address}})
	h.auditStreamAPI(w, r)
}

// AuditForwarder streams new audit events to the configured SIEM.
type AuditForwarder struct {
	Queries *store.Queries
	Egress  *egress.Client
	// Server names this installation in each event (its public URL).
	Server string
	Log    *slog.Logger
}

const auditStreamBatch = 200

// Run implements jobs.Runner: one batch of events after the cursor.
func (f *AuditForwarder) Run(ctx context.Context) (int, error) {
	s, err := f.Queries.GetAuditStream(ctx)
	if err != nil || s.AuditStreamKind == "none" || !s.AuditStreamCursor.Valid || f.Egress == nil {
		return 0, err
	}
	rows, err := f.Queries.AuditEventsAfter(ctx, store.AuditEventsAfterParams{After: s.AuditStreamCursor, RowLimit: auditStreamBatch})
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	lines := make([]auditLine, len(rows))
	for i, e := range rows {
		lines[i] = newAuditLine(store.AuditEvent{ID: e.ID, At: e.At, ActorID: e.ActorID, WorkspaceID: e.WorkspaceID,
			Action: e.Action, TargetType: e.TargetType, TargetID: e.TargetID, IpAddress: e.IpAddress, Detail: e.Detail},
			e.ActorName, e.WorkspaceName, f.Server)
	}
	if s.AuditStreamKind == "http" {
		err = f.post(ctx, s.AuditStreamAddress, s.AuditStreamSecret, lines)
	} else {
		err = f.syslog(ctx, s.AuditStreamAddress, s.AuditStreamTls, lines)
	}
	if err != nil {
		// Kept at the cursor: the same events go again next time.
		_ = f.Queries.SetAuditStreamProgress(ctx, store.SetAuditStreamProgressParams{Cursor: s.AuditStreamCursor, Error: truncate(err.Error(), 500)})
		return 0, err
	}
	if err := f.Queries.SetAuditStreamProgress(ctx, store.SetAuditStreamProgressParams{Cursor: rows[len(rows)-1].ID, Error: ""}); err != nil {
		return 0, err
	}
	return len(rows), nil
}

func (f *AuditForwarder) post(ctx context.Context, address, secret string, lines []auditLine) error {
	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	for _, l := range lines {
		_ = enc.Encode(l)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, address, bytes.NewReader(body.Bytes()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if secret != "" {
		req.Header.Set(signing.Header, signing.Sign(secret, time.Now(), body.Bytes()))
	}
	res, err := f.Egress.Do(req)
	if err != nil {
		return fmt.Errorf("the SIEM endpoint could not be reached: %w", err)
	}
	if res.Status < 200 || res.Status > 299 {
		return fmt.Errorf("the SIEM endpoint answered %d", res.Status)
	}
	return nil
}

// syslog sends RFC 5424 messages (facility security/auth, severity notice)
// with octet-counting framing (RFC 6587), over TLS when asked (RFC 5425).
func (f *AuditForwarder) syslog(ctx context.Context, address string, useTLS bool, lines []auditLine) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := f.Egress.Dial(ctx, "tcp", address)
	if err != nil {
		return fmt.Errorf("the syslog receiver could not be reached: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if useTLS {
		host, _, _ := net.SplitHostPort(address)
		tc := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err := tc.HandshakeContext(ctx); err != nil {
			return fmt.Errorf("TLS with the syslog receiver: %w", err)
		}
		conn = tc
	}
	w := bufio.NewWriter(conn)
	host := f.hostname()
	for _, l := range lines {
		msg, _ := json.Marshal(l)
		frame := fmt.Sprintf("<%d>1 %s %s cenacle - %s - %s", 10*8+5, l.At.UTC().Format(time.RFC3339Nano), host, msgID(l.Action), msg)
		if _, err := fmt.Fprintf(w, "%d %s", len(frame), frame); err != nil {
			return err
		}
	}
	if err := w.Flush(); err != nil {
		return fmt.Errorf("sending to the syslog receiver: %w", err)
	}
	return nil
}

func (f *AuditForwarder) hostname() string {
	if u, err := url.Parse(f.Server); err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	return "-"
}

// msgID is an action as an RFC 5424 MSGID: printable ASCII, no spaces, 32 at most.
func msgID(action string) string {
	b := []byte(action)
	for i, c := range b {
		if c < 33 || c > 126 {
			b[i] = '_'
		}
	}
	if len(b) > 32 {
		b = b[:32]
	}
	if len(b) == 0 {
		return "-"
	}
	return string(b)
}
