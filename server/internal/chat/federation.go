// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Federation: requests between servers are signed with the connection's
// secret and name the receiver's connection id:
//
//	X-Cenacle-Federation: c=<connection id>,t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">,
//	    v2=<hex HMAC-SHA256 of "v2.<t>.<connection id>.<endpoint>.<body>">
//
// v2 (since 0.99.2) also binds the request to the connection and the endpoint
// ("connect" or "events"). Servers before it check v1 and ignore v2; a server
// checks v2 when it is there, and once a connection has signed with v2 it
// takes no request without it (so v2 cannot be stripped off). A valid request
// with v1 only is then noted (v1_refused_at): the other server looks moved back
// below 0.99.2, and the workspace's admins may take v1 again (AcceptFederationV1)
// until it next signs with v2. Outgoing requests carry v1 and v2 always.
const (
	FederationHeader   = "X-Cenacle-Federation"
	federationSkew     = 5 * time.Minute
	federationInviteIn = 24 * time.Hour
	federationBatch    = 100
	CodeFederation     = "federation_failed"
)

// federatedTypes are the events of shared channels that go to other servers.
var federatedTypes = []string{events.MessageCreated, events.MessageUpdated, events.MessageDeleted,
	events.ReactionAdded, events.ReactionRemoved}

// fedPerson is a person as the sending server knows them.
type fedPerson struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// msgRef names a message: "ours" is the sender's id, "yours" the receiver's.
type msgRef struct {
	Ours  string `json:"ours,omitempty"`
	Yours string `json:"yours,omitempty"`
}

// fedEvent is one event between servers.
type fedEvent struct {
	Type      string     `json:"type"`
	ChannelID string     `json:"channel_id"`
	Name      string     `json:"name,omitempty"`
	Topic     string     `json:"topic,omitempty"`
	RemoteID  string     `json:"remote_channel_id,omitempty"`
	Message   *msgRef    `json:"message,omitempty"`
	Root      *msgRef    `json:"root,omitempty"`
	Body      string     `json:"body,omitempty"`
	Author    *fedPerson `json:"author,omitempty"`
	Emoji     string     `json:"emoji,omitempty"`
	CreatedAt time.Time  `json:"created_at,omitzero"`
}

type inviteCode struct {
	URL    string `json:"u"`
	Token  string `json:"t"`
	Secret string `json:"s"`
}

// federationMAC is the v2 signature of a request.
func federationMAC(secret string, ts int64, connection, endpoint string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("v2." + strconv.FormatInt(ts, 10) + "." + connection + "." + endpoint + "."))
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

func federationSign(connection, endpoint, secret string, body []byte) string {
	now := time.Now()
	return "c=" + connection + "," + signing.Sign(secret, now, body) +
		",v2=" + federationMAC(secret, now.Unix(), connection, endpoint, body)
}

// federationVerify checks the signature of a request (the header after the
// connection) for a connection and endpoint: v2 when the request has one,
// else v1 unless v2 is required. It reports whether v2 was checked.
func federationVerify(secret, rest, connection, endpoint string, body []byte, requireV2 bool) (ok, v2 bool) {
	ts, _ := signing.Parse(rest)
	sig := ""
	for _, part := range strings.Split(rest, ",") {
		if v, found := strings.CutPrefix(part, "v2="); found {
			sig = v
		}
	}
	if sig == "" {
		return !requireV2 && signing.Verify(secret, rest, body, time.Now(), federationSkew), false
	}
	if d := time.Since(time.Unix(ts, 0)); ts == 0 || d > federationSkew || d < -federationSkew {
		return false, true
	}
	return hmac.Equal([]byte(sig), []byte(federationMAC(secret, ts, connection, endpoint, body))), true
}

// federationSigned splits a header into the connection it names and the rest.
func federationSigned(header string) (string, string, bool) {
	c, rest, ok := strings.Cut(header, ",")
	id, ok2 := strings.CutPrefix(c, "c=")
	return id, rest, ok && ok2
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) []byte {
	sum := sha256.Sum256([]byte(t))
	return sum[:]
}

func connectionAPI(c store.FederationConnection, shared []store.ListSharedChannelsRow) api.FederationConnection {
	out := api.FederationConnection{Id: uuid(c.ID), Name: c.Name, Url: c.Url,
		Status: api.FederationConnectionStatus(c.Status), LastError: c.LastError, LastSeenAt: timeOf(c.LastSeenAt),
		RequiresV2: c.SignatureVersion >= 2, V1RefusedAt: timeOf(c.V1RefusedAt),
		Policy: ptr(connectionPolicyAPI(c)),
		Shared: []struct {
			ChannelId   openapi_types.UUID                   `json:"channel_id"`
			ChannelName string                               `json:"channel_name"`
			Status      api.FederationConnectionSharedStatus `json:"status"`
		}{}}
	for _, s := range shared {
		out.Shared = append(out.Shared, struct {
			ChannelId   openapi_types.UUID                   `json:"channel_id"`
			ChannelName string                               `json:"channel_name"`
			Status      api.FederationConnectionSharedStatus `json:"status"`
		}{ChannelId: uuid(s.ChannelID), ChannelName: s.ChannelName, Status: api.FederationConnectionSharedStatus(s.Status)})
	}
	return out
}

// --- administration -------------------------------------------------------------

// GetFederation implements api.ServerInterface.
func (h *Handlers) GetFederation(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins manage federation.") {
		return
	}
	conns, err := h.Queries.ListFederationConnections(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list connections", err)
		return
	}
	out := struct {
		Connections []api.FederationConnection `json:"connections"`
		Offers      []api.ChannelOffer         `json:"offers"`
	}{Connections: []api.FederationConnection{}, Offers: []api.ChannelOffer{}}
	for _, c := range conns {
		shared, err := h.Queries.ListSharedChannels(r.Context(), c.ID)
		if err != nil {
			h.unavailable(w, r, "list shared channels", err)
			return
		}
		out.Connections = append(out.Connections, connectionAPI(c, shared))
	}
	offers, err := h.Queries.ListChannelOffers(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list offers", err)
		return
	}
	for _, o := range offers {
		out.Offers = append(out.Offers, api.ChannelOffer{Id: uuid(o.ID), ConnectionId: uuid(o.ConnectionID),
			ConnectionName: o.ConnectionName, Name: o.Name, Topic: o.Topic, CreatedAt: o.CreatedAt})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func connectionName(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, s != "" && utf8.RuneCountInString(s) <= 80
}

// CreateFederationInvite implements api.ServerInterface.
func (h *Handlers) CreateFederationInvite(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins invite other servers.") {
		return
	}
	var in api.CreateFederationInviteJSONBody
	if !decode(w, r, &in) {
		return
	}
	name, ok := connectionName(in.Name)
	if !ok {
		badRequest(w, r, "A connection's name has 1 to 80 characters.")
		return
	}
	token, secret := randomToken(), signing.NewSecret()
	inv, err := h.Queries.CreateFederationInvite(r.Context(), store.CreateFederationInviteParams{
		WorkspaceID: pgUUID(workspaceID), Name: name, TokenHash: hashToken(token), Secret: secret,
		CreatedBy: p.User.ID, ExpiresAt: time.Now().Add(federationInviteIn),
	})
	if err != nil {
		h.unavailable(w, r, "create invite", err)
		return
	}
	// The code carries the secret to the other side's admins: it is shown once, to an admin.
	raw, _ := json.Marshal(inviteCode{URL: strings.TrimRight(h.PublicURL, "/"), Token: token, Secret: secret}) //nolint:gosec // see above
	h.record(r, inv.WorkspaceID, audit.FederationChanged, "workspace", workspaceID.String(), map[string]any{"change": "invited", "name": name})
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{
		"code": base64.RawURLEncoding.EncodeToString(raw), "expires_at": inv.ExpiresAt,
	})
}

// ConnectFederation implements api.ServerInterface.
func (h *Handlers) ConnectFederation(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins connect to other servers.") {
		return
	}
	var in api.ConnectFederationJSONBody
	if !decode(w, r, &in) {
		return
	}
	name, ok := connectionName(in.Name)
	var code inviteCode
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(in.Code))
	if err == nil {
		err = json.Unmarshal(raw, &code)
	}
	u, uerr := url.Parse(code.URL)
	switch {
	case !ok:
		badRequest(w, r, "A connection's name has 1 to 80 characters.")
		return
	case err != nil || uerr != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || code.Token == "" || code.Secret == "":
		badRequest(w, r, "This is not an invitation code of a Cenacle server.")
		return
	}
	if h.Egress == nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadGateway, Code: CodeFederation, Detail: "This server cannot reach others."})
		return
	}
	if allowed, err := serverAllowed(r.Context(), h.Queries, code.URL); err != nil {
		h.unavailable(w, r, "federation policy", err)
		return
	} else if !allowed {
		federationDenied(w, r, code.URL)
		return
	}
	conn, err := h.Queries.CreateFederationConnection(r.Context(), store.CreateFederationConnectionParams{
		WorkspaceID: pgUUID(workspaceID), Name: name, Url: strings.TrimRight(code.URL, "/"), Secret: code.Secret,
		Status: "pending", CreatedBy: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "create connection", err)
		return
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return
	}
	body, _ := json.Marshal(map[string]string{
		"token": code.Token, "url": strings.TrimRight(h.PublicURL, "/"), "name": ws.Name, "id": uuid(conn.ID).String(),
	})
	res, status, problem := h.federationPost(r.Context(), conn.Url+"/api/federation/v1/connect", "invite", code.Secret, body)
	var answer struct {
		ID string `json:"id"`
	}
	if problem == "" && json.Unmarshal(res, &answer) != nil {
		problem = "The other server's answer was not understood."
	}
	remote, perr := guuid.Parse(answer.ID)
	if problem == "" && perr != nil {
		problem = "The other server's answer was not understood."
	}
	if problem != "" {
		_ = h.Queries.DeleteFederationConnection(context.WithoutCancel(r.Context()), conn.ID)
		h.Log.WarnContext(r.Context(), "federation connect", "status", status, "problem", problem)
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadGateway, Code: CodeFederation, Detail: problem})
		return
	}
	conn, err = h.Queries.ActivateFederationConnection(r.Context(), store.ActivateFederationConnectionParams{ID: conn.ID, RemoteID: pgUUID(remote)})
	if err != nil {
		h.unavailable(w, r, "activate connection", err)
		return
	}
	h.record(r, conn.WorkspaceID, audit.FederationChanged, "workspace", workspaceID.String(), map[string]any{"change": "connected", "name": name, "url": conn.Url})
	httpx.WriteJSON(w, http.StatusCreated, connectionAPI(conn, nil))
}

// federationPost sends a signed request to another server.
func (h *Handlers) federationPost(ctx context.Context, target, connection, secret string, body []byte) ([]byte, int, string) {
	return federationPost(ctx, h.Egress, target, connection, secret, body)
}

func federationPost(ctx context.Context, client *egress.Client, target, connection, secret string, body []byte) ([]byte, int, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Cenacle")
	endpoint := target[strings.LastIndex(target, "/")+1:] // "connect" or "events"
	req.Header.Set(FederationHeader, federationSign(connection, endpoint, secret, body))
	res, err := client.Do(req)
	switch {
	case errors.Is(err, egress.ErrForbiddenAddress):
		return nil, 0, "The address is in a network Cenacle may not reach (see CENACLE_EGRESS_ALLOW)."
	case err != nil:
		return nil, 0, err.Error()
	case res.Status < 200 || res.Status > 299:
		return res.Body, res.Status, fmt.Sprintf("The other server answered %d.", res.Status)
	}
	return res.Body, res.Status, ""
}

func (h *Handlers) adminConnection(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.FederationConnection, bool) {
	c, err := h.Queries.GetFederationConnection(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such connection."})
		return c, false
	}
	if err != nil {
		h.unavailable(w, r, "get connection", err)
		return c, false
	}
	return c, h.requireWorkspaceAdmin(w, r, uuid(c.WorkspaceID), user, "Only the workspace's owners and admins manage federation.")
}

// UpdateFederationConnection implements api.ServerInterface.
func (h *Handlers) UpdateFederationConnection(w http.ResponseWriter, r *http.Request, connectionID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.adminConnection(w, r, connectionID, p.User)
	if !ok {
		return
	}
	var in api.UpdateFederationConnectionJSONBody
	if !decode(w, r, &in) {
		return
	}
	if c.Status == "pending" {
		badRequest(w, r, "The connection is not set up yet.")
		return
	}
	if in.Policy != nil && (in.Policy.RequestsPerMinute < 1 || in.Policy.RequestsPerMinute > 6000) {
		badRequest(w, r, "requests_per_minute is 1 to 6000.")
		return
	}
	var err error
	if in.Enabled != nil {
		status := "disabled"
		if *in.Enabled {
			status = "active"
		}
		if c, err = h.Queries.SetFederationConnectionStatus(r.Context(), store.SetFederationConnectionStatusParams{ID: c.ID, Status: status}); err != nil {
			h.unavailable(w, r, "update connection", err)
			return
		}
		h.record(r, c.WorkspaceID, audit.FederationChanged, "workspace", uuid(c.WorkspaceID).String(), map[string]any{"change": status, "name": c.Name})
	}
	if pol := in.Policy; pol != nil {
		if c, err = h.Queries.SetFederationConnectionPolicy(r.Context(), store.SetFederationConnectionPolicyParams{
			ID: c.ID, ReceiveMessages: pol.ReceiveMessages, ReceiveReactions: pol.ReceiveReactions,
			ReceiveEdits: pol.ReceiveEdits, RequestsPerMinute: int32(pol.RequestsPerMinute), //nolint:gosec // checked above
		}); err != nil {
			h.unavailable(w, r, "update connection", err)
			return
		}
		h.record(r, c.WorkspaceID, audit.FederationChanged, "workspace", uuid(c.WorkspaceID).String(),
			map[string]any{"change": "policy", "name": c.Name, "policy": pol})
	}
	shared, _ := h.Queries.ListSharedChannels(r.Context(), c.ID)
	httpx.WriteJSON(w, http.StatusOK, connectionAPI(c, shared))
}

// AcceptFederationV1 implements api.ServerInterface: the other server was
// moved back below 0.99.2, so its requests are taken with v1 again until it
// next signs with v2.
func (h *Handlers) AcceptFederationV1(w http.ResponseWriter, r *http.Request, connectionID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.adminConnection(w, r, connectionID, p.User)
	if !ok {
		return
	}
	if c.Status == "pending" {
		badRequest(w, r, "The connection is not set up yet.")
		return
	}
	c, err := h.Queries.AcceptFederationV1(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "update connection", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.FederationChanged, "workspace", uuid(c.WorkspaceID).String(), map[string]any{"change": "v1_accepted", "name": c.Name})
	shared, _ := h.Queries.ListSharedChannels(r.Context(), c.ID)
	httpx.WriteJSON(w, http.StatusOK, connectionAPI(c, shared))
}

// DeleteFederationConnection implements api.ServerInterface.
func (h *Handlers) DeleteFederationConnection(w http.ResponseWriter, r *http.Request, connectionID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.adminConnection(w, r, connectionID, p.User)
	if !ok {
		return
	}
	if err := h.Queries.DeleteFederationConnection(r.Context(), c.ID); err != nil {
		h.unavailable(w, r, "delete connection", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.FederationChanged, "workspace", uuid(c.WorkspaceID).String(), map[string]any{"change": "removed", "name": c.Name})
	w.WriteHeader(http.StatusNoContent)
}

// --- sharing channels --------------------------------------------------------------

// ListChannelShares implements api.ServerInterface.
func (h *Handlers) ListChannelShares(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListChannelShares(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list shares", err)
		return
	}
	out := make([]api.ChannelShare, len(rows))
	for i, s := range rows {
		out[i] = api.ChannelShare{ConnectionId: uuid(s.ConnectionID), ConnectionName: s.ConnectionName, Status: api.ChannelShareStatus(s.Status)}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.ChannelShare{"shares": out})
}

// ShareChannel implements api.ServerInterface.
func (h *Handlers) ShareChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	var in api.ShareChannelJSONBody
	if !decode(w, r, &in) {
		return
	}
	switch {
	case !role.admin():
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins share channels with other servers.")
		return
	case isConversation(c) || c.Encrypted || c.ArchivedAt.Valid || c.Kind == KindForum:
		badRequest(w, r, "Conversations, encrypted, archived channels and forums are not shared with other servers.")
		return
	}
	conn, err := h.Queries.GetFederationConnection(r.Context(), pgUUID(in.ConnectionId))
	if isNoRows(err) || (err == nil && (conn.WorkspaceID != c.WorkspaceID || conn.Status != "active")) {
		badRequest(w, r, "No active connection of this workspace with this id.")
		return
	}
	if err != nil {
		h.unavailable(w, r, "get connection", err)
		return
	}
	var share store.SharedChannel
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if share, err = q.ShareChannel(r.Context(), store.ShareChannelParams{ChannelID: c.ID, ConnectionID: conn.ID}); err != nil {
			return err
		}
		raw, _ := json.Marshal(fedEvent{Type: "channel.offered", ChannelID: uuid(c.ID).String(), Name: c.Name, Topic: c.Topic})
		return q.QueueFederationDelivery(r.Context(), store.QueueFederationDeliveryParams{ConnectionID: conn.ID, Event: raw})
	})
	if err != nil {
		h.unavailable(w, r, "share channel", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.FederationChanged, "channel", uuid(c.ID).String(), map[string]any{"change": "shared", "channel": c.Name, "with": conn.Name})
	httpx.WriteJSON(w, http.StatusCreated, api.ChannelShare{ConnectionId: uuid(conn.ID), ConnectionName: conn.Name, Status: api.ChannelShareStatus(share.Status)})
}

// UnshareChannel implements api.ServerInterface.
func (h *Handlers) UnshareChannel(w http.ResponseWriter, r *http.Request, channelID, connectionID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.visibleChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !role.admin() {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins stop sharing channels.")
		return
	}
	share, err := h.Queries.GetSharedChannel(r.Context(), store.GetSharedChannelParams{ChannelID: c.ID, ConnectionID: pgUUID(connectionID)})
	if isNoRows(err) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.unavailable(w, r, "get share", err)
		return
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.UnshareChannel(r.Context(), store.UnshareChannelParams{ChannelID: c.ID, ConnectionID: share.ConnectionID}); err != nil {
			return err
		}
		if !share.RemoteChannelID.Valid {
			return nil
		}
		raw, _ := json.Marshal(fedEvent{Type: "channel.unshared", ChannelID: uuid(share.RemoteChannelID).String()})
		return q.QueueFederationDelivery(r.Context(), store.QueueFederationDeliveryParams{ConnectionID: share.ConnectionID, Event: raw})
	})
	if err != nil {
		h.unavailable(w, r, "unshare channel", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.FederationChanged, "channel", uuid(c.ID).String(), map[string]any{"change": "unshared", "channel": c.Name})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) adminOffer(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.ChannelOffer, store.FederationConnection, bool) {
	o, err := h.Queries.GetChannelOffer(r.Context(), pgUUID(id))
	var conn store.FederationConnection
	if err == nil {
		conn, err = h.Queries.GetFederationConnection(r.Context(), o.ConnectionID)
	}
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such offer."})
		return o, conn, false
	}
	if err != nil {
		h.unavailable(w, r, "get offer", err)
		return o, conn, false
	}
	return o, conn, h.requireWorkspaceAdmin(w, r, uuid(conn.WorkspaceID), user, "Only the workspace's owners and admins accept shared channels.")
}

// AcceptChannelOffer implements api.ServerInterface.
func (h *Handlers) AcceptChannelOffer(w http.ResponseWriter, r *http.Request, offerID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	o, conn, ok := h.adminOffer(w, r, offerID, p.User)
	if !ok {
		return
	}
	name, problem := cleanName(o.Name)
	if problem != "" {
		name = "shared-" + uuid(o.ID).String()[:8]
	}
	// A name taken here gets the other server's name after it.
	if _, err := h.Queries.GetChannelByName(r.Context(), store.GetChannelByNameParams{WorkspaceID: conn.WorkspaceID, Name: name}); err == nil {
		name = truncate(name+" ("+conn.Name+")", 80)
	}
	var c store.Channel
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		c, err = q.CreateChannel(r.Context(), store.CreateChannelParams{
			WorkspaceID: conn.WorkspaceID, Name: name, Topic: truncate(o.Topic, 250), Kind: KindStandard,
			Visibility: Private, CreatedBy: p.User.ID,
		})
		if err != nil {
			return err
		}
		if _, err := q.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: p.User.ID, Role: RoleManager}); err != nil {
			return err
		}
		if _, err := q.CreateActiveSharedChannel(r.Context(), store.CreateActiveSharedChannelParams{
			ChannelID: c.ID, ConnectionID: conn.ID, RemoteChannelID: o.RemoteChannelID,
		}); err != nil {
			return err
		}
		if err := q.DeleteChannelOffer(r.Context(), o.ID); err != nil {
			return err
		}
		raw, _ := json.Marshal(fedEvent{Type: "channel.accepted", ChannelID: uuid(o.RemoteChannelID).String(), RemoteID: uuid(c.ID).String()})
		return q.QueueFederationDelivery(r.Context(), store.QueueFederationDeliveryParams{ConnectionID: conn.ID, Event: raw})
	})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A channel with this name exists; rename it first."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "accept offer", err)
		return
	}
	role, _ := h.workspaceRole(w, r, uuid(conn.WorkspaceID), p.User)
	out := toAPI(c, access{ch: RoleManager, ws: role})
	h.publish(r.Context(), events.ChannelJoined, ChannelEvent{Channel: out, UserID: uuid(p.User.ID).String()})
	h.record(r, c.WorkspaceID, audit.FederationChanged, "channel", uuid(c.ID).String(), map[string]any{"change": "accepted", "channel": c.Name, "from": conn.Name})
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// DeclineChannelOffer implements api.ServerInterface.
func (h *Handlers) DeclineChannelOffer(w http.ResponseWriter, r *http.Request, offerID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	o, _, ok := h.adminOffer(w, r, offerID, p.User)
	if !ok {
		return
	}
	if err := h.Queries.DeleteChannelOffer(r.Context(), o.ID); err != nil {
		h.unavailable(w, r, "decline offer", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- server to server ------------------------------------------------------------

func readSigned(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if err != nil {
		badRequest(w, r, "The body is too large.")
		return nil, false
	}
	return body, true
}

func federationRefused(w http.ResponseWriter, r *http.Request) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusUnauthorized, Code: httpx.CodeUnauthenticated,
		Detail: "The request is not signed for a connection of this server."})
}

// FederationConnect implements api.ServerInterface.
func (h *Handlers) FederationConnect(w http.ResponseWriter, r *http.Request) {
	body, ok := readSigned(w, r)
	if !ok {
		return
	}
	var in struct{ Token, URL, Name, ID string }
	if json.Unmarshal(body, &in) != nil || in.Token == "" {
		badRequest(w, r, "Not a connection request.")
		return
	}
	id, rest, signed := federationSigned(r.Header.Get(FederationHeader))
	inv, err := h.Queries.GetFederationInviteByHash(r.Context(), hashToken(in.Token))
	var verified, v2 bool
	if err == nil {
		verified, v2 = federationVerify(inv.Secret, rest, "invite", "connect", body, false)
	}
	if isNoRows(err) || !signed || id != "invite" || (err == nil && !verified) {
		federationRefused(w, r)
		return
	}
	if err != nil {
		h.unavailable(w, r, "get invite", err)
		return
	}
	remote, perr := guuid.Parse(in.ID)
	u, uerr := url.Parse(in.URL)
	if perr != nil || uerr != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		badRequest(w, r, "The request names no server address or connection.")
		return
	}
	if allowed, err := serverAllowed(r.Context(), h.Queries, in.URL); err != nil {
		h.unavailable(w, r, "federation policy", err)
		return
	} else if !allowed {
		h.record(r, inv.WorkspaceID, audit.FederationRefused, "workspace", uuid(inv.WorkspaceID).String(),
			map[string]any{"server": serverHost(in.URL), "reason": "policy"})
		federationDenied(w, r, in.URL)
		return
	}
	var conn store.FederationConnection
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if _, err := q.UseFederationInvite(r.Context(), hashToken(in.Token)); err != nil {
			return err
		}
		var err error
		conn, err = q.CreateFederationConnection(r.Context(), store.CreateFederationConnectionParams{
			WorkspaceID: inv.WorkspaceID, Name: inv.Name, Url: strings.TrimRight(in.URL, "/"), Secret: inv.Secret,
			RemoteID: pgUUID(remote), Status: "active", CreatedBy: inv.CreatedBy,
		})
		if err != nil || !v2 {
			return err
		}
		return q.RequireFederationV2(r.Context(), conn.ID) // that server signs with v2
	})
	if isNoRows(err) { // used or expired in between
		federationRefused(w, r)
		return
	}
	if err != nil {
		h.unavailable(w, r, "accept connection", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"id": uuid(conn.ID).String()})
}

// FederationEvents implements api.ServerInterface.
func (h *Handlers) FederationEvents(w http.ResponseWriter, r *http.Request) {
	body, ok := readSigned(w, r)
	if !ok {
		return
	}
	id, rest, signed := federationSigned(r.Header.Get(FederationHeader))
	connID, perr := guuid.Parse(id)
	if !signed || perr != nil {
		federationRefused(w, r)
		return
	}
	conn, err := h.Queries.GetFederationConnection(r.Context(), pgUUID(connID))
	var verified, v2 bool
	if err == nil {
		verified, v2 = federationVerify(conn.Secret, rest, id, "events", body, conn.SignatureVersion >= 2)
	}
	if err == nil && !verified && !v2 && conn.SignatureVersion >= 2 &&
		(!conn.V1RefusedAt.Valid || time.Since(conn.V1RefusedAt.Time) > time.Minute) &&
		signing.Verify(conn.Secret, rest, body, time.Now(), federationSkew) {
		// Signed by the connection's secret, but only with v1: the other
		// server looks moved back. Refused all the same; its admins decide.
		if err := h.Queries.NoteFederationV1Refused(r.Context(), conn.ID); err != nil {
			h.Log.WarnContext(r.Context(), "federation v1 refused", "connection", conn.Name, "error", err)
		}
	}
	if isNoRows(err) || (err == nil && !verified) {
		federationRefused(w, r)
		return
	}
	if err != nil {
		h.unavailable(w, r, "get connection", err)
		return
	}
	if conn.Status != "active" {
		forbidden(w, r, CodeFederation, "This connection is paused here.")
		return
	}
	if allowed, err := serverAllowed(r.Context(), h.Queries, conn.Url); err != nil {
		h.unavailable(w, r, "federation policy", err)
		return
	} else if !allowed {
		federationDenied(w, r, conn.Url)
		return
	}
	if over, wait, err := h.overRate(r.Context(), conn); err != nil {
		h.unavailable(w, r, "federation rate", err)
		return
	} else if over {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(wait.Seconds()))))
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
			Detail: "This connection sends more than its limit; try again later."})
		return
	}
	var in struct {
		Events []fedEvent `json:"events"`
	}
	if json.Unmarshal(body, &in) != nil || len(in.Events) > federationBatch {
		badRequest(w, r, "Not a batch of events.")
		return
	}
	// A signed request is taken once: within the time it is valid, the same
	// time and body again is a replay (an honest server signs each attempt
	// anew).
	replay := ""
	if h.Replays != nil {
		ts, _ := signing.Parse(rest)
		replay = federationReplayKey(conn.ID, ts, body)
		if fresh, err := h.Replays.Once(r.Context(), replay, 2*federationSkew); err != nil {
			h.unavailable(w, r, "federation replay", err)
			return
		} else if !fresh {
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeFederation,
				Detail: "This request was received before."})
			return
		}
	}
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		for _, ev := range in.Events {
			if err := h.applyFederated(r.Context(), q, conn, ev); err != nil {
				return fmt.Errorf("%s: %w", ev.Type, err)
			}
		}
		if v2 && (conn.SignatureVersion < 2 || conn.V1RefusedAt.Valid) { // from now on, only with v2
			if err := q.RequireFederationV2(r.Context(), conn.ID); err != nil {
				return err
			}
		}
		return q.TouchFederationConnection(r.Context(), conn.ID)
	})
	if err != nil {
		h.Log.WarnContext(r.Context(), "federation events", "connection", conn.Name, "error", err)
		if replay != "" { // nothing was applied: the sender may repeat it
			_ = h.Replays.Forget(context.WithoutCancel(r.Context()), replay)
		}
		h.unavailable(w, r, "apply federated events", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// federationReplayKey names a signed request of a connection: its time and body.
func federationReplayKey(conn pgtype.UUID, ts int64, body []byte) string {
	sum := sha256.Sum256(append([]byte(strconv.FormatInt(ts, 10)+"."), body...))
	return "cenacle:federation:replay:" + uuid(conn).String() + ":" + hex.EncodeToString(sum[:])
}

var errFederated = errors.New("federated event refers to nothing here")

// applyFederated applies one event of another server. Events that refer to
// channels or messages no longer here are dropped (not retried).
func (h *Handlers) applyFederated(ctx context.Context, q *store.Queries, conn store.FederationConnection, ev fedEvent) error {
	channelID, err := guuid.Parse(ev.ChannelID)
	if err != nil {
		return nil
	}
	switch ev.Type {
	case "channel.offered":
		_, err := q.UpsertChannelOffer(ctx, store.UpsertChannelOfferParams{ConnectionID: conn.ID, RemoteChannelID: pgUUID(channelID),
			Name: truncate(ev.Name, 80), Topic: truncate(ev.Topic, 250)})
		return err
	case "channel.accepted":
		remote, err := guuid.Parse(ev.RemoteID)
		if err != nil {
			return nil
		}
		_, err = q.AcceptSharedChannel(ctx, store.AcceptSharedChannelParams{ChannelID: pgUUID(channelID), ConnectionID: conn.ID, RemoteChannelID: pgUUID(remote)})
		if isNoRows(err) {
			return nil
		}
		return err
	case "channel.unshared":
		return q.UnshareChannel(ctx, store.UnshareChannelParams{ChannelID: pgUUID(channelID), ConnectionID: conn.ID})
	}
	share, err := q.GetSharedChannel(ctx, store.GetSharedChannelParams{ChannelID: pgUUID(channelID), ConnectionID: conn.ID})
	if isNoRows(err) || (err == nil && share.Status != "active") {
		return nil
	}
	if err != nil {
		return err
	}
	c, err := q.GetChannel(ctx, share.ChannelID)
	if err != nil {
		return err
	}
	// An archived channel takes nothing more; an encrypted one cannot take
	// text it could not read (dropped, so the rest of the batch goes through).
	if c.ArchivedAt.Valid || c.Encrypted {
		return nil
	}
	if !takes(conn, ev.Type) {
		return nil // this server's policy for the connection leaves it out
	}
	switch ev.Type {
	case events.MessageCreated:
		return h.federatedMessage(ctx, q, conn, c, ev)
	case events.MessageUpdated, events.MessageDeleted:
		m, ok, err := h.federatedTarget(ctx, q, conn, c, ev.Message)
		if err != nil || !ok {
			return err
		}
		// Only what came from there changes from there.
		if from, _ := q.GetRemoteAuthor(ctx, m.AuthorID); !strings.HasPrefix(from, uuid(conn.ID).String()+":") {
			return nil
		}
		if ev.Type == events.MessageDeleted {
			if m.DeletedAt.Valid {
				return nil
			}
			if _, err := q.DeleteMessage(ctx, store.DeleteMessageParams{ID: m.ID, DeletedBy: m.AuthorID}); err != nil {
				return err
			}
			ref := MessageRef{ID: uuid(m.ID).String(), ChannelID: uuid(c.ID).String()}
			if m.RootID.Valid {
				ref.RootID = uuid(m.RootID).String()
			}
			return emit(ctx, q, events.MessageDeleted, ref)
		}
		body, problem := validBody(ev.Body)
		if problem != "" || m.DeletedAt.Valid || body == m.Body {
			return nil
		}
		// An edit is held to the author's posting rules here, as a local edit is.
		author, err := q.GetUser(ctx, m.AuthorID)
		if err != nil {
			return err
		}
		v, ok, err := federatedRules(ctx, q, c, author, body, postOptions{anyChannel: true})
		if err != nil || !ok {
			return err
		}
		edited, err := q.EditMessage(ctx, store.EditMessageParams{ID: m.ID, Body: body})
		if err != nil {
			return err
		}
		msgs := []api.Message{messageAPI(edited, m.AuthorName, false)}
		if err := decorate(ctx, q, m.AuthorID, msgs); err != nil {
			return err
		}
		if err := flagMessage(ctx, q, c, msgs[0].Id, v.flags); err != nil {
			return err
		}
		return emit(ctx, q, events.MessageUpdated, msgs[0])
	case events.ReactionAdded, events.ReactionRemoved:
		m, ok, err := h.federatedTarget(ctx, q, conn, c, ev.Message)
		if err != nil || !ok || ev.Author == nil || !validEmoji(ev.Emoji) {
			return err
		}
		person, err := remoteMember(ctx, q, conn, c, *ev.Author)
		if errors.Is(err, errFederated) {
			return nil
		}
		if err != nil {
			return err
		}
		var n int64
		if ev.Type == events.ReactionAdded {
			// The channel's rules on reacting apply to the remote guest, as here.
			role, err := memberAccess(ctx, q, c, person)
			if err != nil {
				return err
			}
			if !canReact(c, role) {
				return nil
			}
			if no, err := memberTimeout(ctx, q, c.WorkspaceID, person); err != nil || no != nil {
				return err
			}
			if n, err = q.AddReaction(ctx, store.AddReactionParams{MessageID: m.ID, Emoji: ev.Emoji, UserID: person.ID}); err != nil {
				return err
			}
		} else {
			n, err = q.RemoveReaction(ctx, store.RemoveReactionParams{MessageID: m.ID, Emoji: ev.Emoji, UserID: person.ID})
		}
		if err != nil || n == 0 {
			return err
		}
		return emit(ctx, q, ev.Type, ReactionEvent{ChannelID: uuid(c.ID).String(), MessageID: uuid(m.ID).String(),
			Emoji: ev.Emoji, UserID: uuid(person.ID).String()})
	}
	return nil
}

// remoteMember is a person of another server as a guest here, in the channel.
func remoteMember(ctx context.Context, q *store.Queries, conn store.FederationConnection, c store.Channel, p fedPerson) (store.User, error) {
	if _, err := guuid.Parse(p.ID); err != nil {
		return store.User{}, errFederated
	}
	name := strings.TrimSpace(p.Name)
	if name == "" || utf8.RuneCountInString(name) > 60 {
		name = "?"
	}
	u, err := q.UpsertRemoteUser(ctx, store.UpsertRemoteUserParams{
		AuthData: uuid(conn.ID).String() + ":" + p.ID, DisplayName: name + " (" + conn.Name + ")",
	})
	if err != nil {
		return u, err
	}
	if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{WorkspaceID: c.WorkspaceID, UserID: u.ID, Role: WorkspaceGuest}); err != nil {
		return u, err
	}
	_, err = q.AddMember(ctx, store.AddMemberParams{ChannelID: c.ID, UserID: u.ID, Role: RoleMember})
	return u, err
}

// memberAccess is what a person may do in a channel by their roles there.
func memberAccess(ctx context.Context, q *store.Queries, c store.Channel, user store.User) (access, error) {
	ws, err := q.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: c.WorkspaceID, UserID: user.ID})
	if err != nil {
		return access{}, err
	}
	ch, err := q.GetMemberRole(ctx, store.GetMemberRoleParams{ChannelID: c.ID, UserID: user.ID})
	return access{ch: ch, ws: ws}, err
}

// federatedRules applies this server's posting rules to what a person of
// another server writes in a shared channel; ok is false when they refuse it.
func federatedRules(ctx context.Context, q *store.Queries, c store.Channel, author store.User, body string, o postOptions) (postVerdict, bool, error) {
	role, err := memberAccess(ctx, q, c, author)
	if err != nil {
		return postVerdict{}, false, err
	}
	v, no, err := postingRules(ctx, q, c, role, author, body, o)
	return v, no == nil && err == nil, err
}

// federatedTarget finds the local message an event refers to.
func (h *Handlers) federatedTarget(ctx context.Context, q *store.Queries, conn store.FederationConnection, c store.Channel, ref *msgRef) (store.GetMessageRow, bool, error) {
	if ref == nil {
		return store.GetMessageRow{}, false, nil
	}
	var id pgtype.UUID
	if ref.Yours != "" {
		local, err := guuid.Parse(ref.Yours)
		if err != nil {
			return store.GetMessageRow{}, false, nil
		}
		id = pgUUID(local)
	} else {
		remote, err := guuid.Parse(ref.Ours)
		if err != nil {
			return store.GetMessageRow{}, false, nil
		}
		id, err = q.LocalMessageOf(ctx, store.LocalMessageOfParams{ConnectionID: conn.ID, RemoteMessageID: pgUUID(remote)})
		if isNoRows(err) {
			return store.GetMessageRow{}, false, nil
		}
		if err != nil {
			return store.GetMessageRow{}, false, err
		}
	}
	m, err := q.GetMessage(ctx, store.GetMessageParams{ID: id, ChannelID: c.ID})
	if isNoRows(err) {
		return m, false, nil
	}
	return m, err == nil, err
}

func (h *Handlers) federatedMessage(ctx context.Context, q *store.Queries, conn store.FederationConnection, c store.Channel, ev fedEvent) error {
	if ev.Author == nil || ev.Message == nil {
		return nil
	}
	remoteID, err := guuid.Parse(ev.Message.Ours)
	if err != nil {
		return nil
	}
	body, problem := validBody(ev.Body)
	if problem != "" {
		return nil
	}
	author, err := remoteMember(ctx, q, conn, c, *ev.Author)
	if errors.Is(err, errFederated) {
		return nil
	}
	if err != nil {
		return err
	}
	var reply replyTo
	if ev.Root != nil {
		root, ok, err := h.federatedTarget(ctx, q, conn, c, ev.Root)
		if err != nil {
			return err
		}
		if ok && !root.RootID.Valid {
			reply = replyTo{root: root}
		}
	}
	// The remote author is a guest here, held to this channel's posting
	// rules like a local guest; a message they refuse is dropped. Slow mode
	// is left to the author's server: a batch held back by an outage arrives
	// at once and must not lose its messages.
	v, ok, err := federatedRules(ctx, q, c, author, body, postOptions{})
	if err != nil || !ok {
		return err
	}
	if reply.isReply() {
		role, err := memberAccess(ctx, q, c, author)
		if err != nil || !canReply(c, role) {
			return err
		}
	}
	nonce := "fed-" + remoteID.String()
	m, err := postMessageTo(ctx, q, c, author, body, nonce, []byte("[]"), reply, postExtras{noGroups: v.noGroups})
	if errors.Is(err, errNonceReused) {
		// A repeat of a message deleted here since (or moved): dropped, so
		// the connection's later events still go through.
		return nil
	}
	if err != nil {
		return err
	}
	if err := flagMessage(ctx, q, c, m.Id, v.flags); err != nil {
		return err
	}
	return q.RecordFederatedMessage(ctx, store.RecordFederatedMessageParams{MessageID: pgUUID(m.Id), ConnectionID: conn.ID, RemoteMessageID: pgUUID(remoteID)})
}

// --- outgoing ----------------------------------------------------------------------

// queueFederation records an event of a shared channel for the servers it is
// shared with, in the transaction of the change. Events that came from a
// server do not go back to it.
func queueFederation(ctx context.Context, q store.Querier, typ string, raw []byte) error {
	if !slices.Contains(federatedTypes, typ) {
		return nil
	}
	var d struct {
		ID        string        `json:"id"`
		ChannelID string        `json:"channel_id"`
		MessageID string        `json:"message_id"`
		UserID    string        `json:"user_id"`
		Emoji     string        `json:"emoji"`
		Body      string        `json:"body"`
		RootID    *string       `json:"root_id"`
		CreatedAt time.Time     `json:"created_at"`
		Author    *api.Author   `json:"author"`
		Mentions  []api.Person  `json:"mentions"`
		Burn      *api.BurnInfo `json:"burn"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return err
	}
	channel, err := guuid.Parse(d.ChannelID)
	if err != nil {
		return nil
	}
	shares, err := q.ActiveSharesOfChannel(ctx, pgUUID(channel))
	if err != nil || len(shares) == 0 {
		return err
	}
	actorID, actorName := d.UserID, ""
	if d.Author != nil {
		actorID, actorName = d.Author.Id.String(), d.Author.DisplayName
	}
	if d.Burn != nil || ((typ == events.MessageCreated || typ == events.MessageUpdated) && strings.TrimSpace(d.Body) == "") {
		return nil // burn-on-read and messages without text stay here
	}
	actor, _ := guuid.Parse(actorID)
	origin := ""
	if a, err := q.GetRemoteAuthor(ctx, pgUUID(actor)); err == nil {
		origin, _, _ = strings.Cut(a, ":")
	}
	if actorName == "" && (typ == events.ReactionAdded || typ == events.ReactionRemoved) {
		if u, err := q.GetUser(ctx, pgUUID(actor)); err == nil {
			actorName = u.DisplayName
		}
	}
	for _, s := range shares {
		if uuid(s.ConnectionID).String() == origin {
			continue
		}
		ev := fedEvent{Type: typ, ChannelID: uuid(s.RemoteChannelID).String(), Author: &fedPerson{ID: actorID, Name: actorName}}
		ref := func(id string) (*msgRef, error) {
			local, err := guuid.Parse(id)
			if err != nil {
				return nil, nil
			}
			remote, err := q.RemoteMessageOf(ctx, store.RemoteMessageOfParams{ConnectionID: s.ConnectionID, MessageID: pgUUID(local)})
			if isNoRows(err) {
				return &msgRef{Ours: id}, nil
			}
			if err != nil {
				return nil, err
			}
			return &msgRef{Yours: uuid(remote).String()}, nil
		}
		switch typ {
		case events.MessageCreated, events.MessageUpdated:
			ev.Body = mentionsAsNames(d.Body, d.Mentions)
			ev.CreatedAt = d.CreatedAt
			if ev.Message, err = ref(d.ID); err != nil {
				return err
			}
			if d.RootID != nil {
				if ev.Root, err = ref(*d.RootID); err != nil {
					return err
				}
			}
		case events.MessageDeleted:
			ev.Author = nil
			if ev.Message, err = ref(d.ID); err != nil {
				return err
			}
		default: // reactions
			ev.Emoji = d.Emoji
			if ev.Message, err = ref(d.MessageID); err != nil {
				return err
			}
		}
		raw, _ := json.Marshal(ev)
		if err := q.QueueFederationDelivery(ctx, store.QueueFederationDeliveryParams{ConnectionID: s.ConnectionID, Event: raw,
			MessageID: copiedMessage(typ, d.ID, d.MessageID)}); err != nil {
			return err
		}
	}
	return nil
}

var mentionTokenRE = regexp.MustCompile(`<@([0-9a-f-]{36})>`)

// mentionsAsNames writes mentions as names: ids mean nothing on another server.
func mentionsAsNames(body string, people []api.Person) string {
	return mentionTokenRE.ReplaceAllStringFunc(body, func(tok string) string {
		id := mentionTokenRE.FindStringSubmatch(tok)[1]
		for _, p := range people {
			if p.Id.String() == id {
				return "@" + p.DisplayName
			}
		}
		return "@someone"
	})
}

// FederationSender sends queued events to the servers they are for.
type FederationSender struct {
	DB      TxBeginner
	Queries *store.Queries
	Egress  *egress.Client
	Log     *slog.Logger
}

// Run implements jobs.Runner: one batch per connection with due events.
func (f *FederationSender) Run(ctx context.Context) (int, error) {
	if f.Egress == nil {
		return 0, nil
	}
	conns, err := f.Queries.DueFederationConnections(ctx)
	if err != nil {
		return 0, err
	}
	sent := 0
	for _, id := range conns {
		n, err := f.send(ctx, id)
		if err != nil {
			f.Log.WarnContext(ctx, "federation delivery", "connection", uuid(id).String(), "error", err)
			continue
		}
		sent += n
	}
	return sent, nil
}

func (f *FederationSender) send(ctx context.Context, id pgtype.UUID) (int, error) {
	conn, err := f.Queries.GetFederationConnection(ctx, id)
	if err != nil {
		return 0, err
	}
	if allowed, err := serverAllowed(ctx, f.Queries, conn.Url); err != nil {
		return 0, err
	} else if !allowed {
		// Kept until the policy allows the server again (or the connection goes).
		return 0, f.Queries.SetFederationError(ctx, store.SetFederationErrorParams{ID: id,
			LastError: "This server's federation policy does not allow " + serverHost(conn.Url) + "."})
	}
	n := 0
	err = inTx(ctx, f.DB, func(q *store.Queries) error {
		// One sender per connection, so its events reach the other server in
		// the order they were queued (a deletion never before its message).
		if locked, err := q.LockFederationSending(ctx, id); err != nil || !locked {
			return err
		}
		rows, err := q.ClaimFederationDeliveries(ctx, store.ClaimFederationDeliveriesParams{ConnectionID: id, RowLimit: federationBatch})
		if err != nil || len(rows) == 0 {
			return err
		}
		ids := make([]pgtype.UUID, len(rows))
		batch := make([]json.RawMessage, len(rows))
		for i, d := range rows {
			ids[i], batch[i] = d.ID, d.Event
		}
		body, _ := json.Marshal(map[string]any{"events": batch})
		_, _, problem := federationPost(ctx, f.Egress, conn.Url+"/api/federation/v1/events", uuid(conn.RemoteID).String(), conn.Secret, body)
		if problem != "" {
			if err := q.SetFederationError(ctx, store.SetFederationErrorParams{ID: id, LastError: truncate(problem, 500)}); err != nil {
				return err
			}
			// The batch waits for its retry, and the connection's later
			// events wait behind it (ClaimFederationDeliveries).
			return q.RetryFederationDeliveries(ctx, ids)
		}
		n = len(rows)
		if err := q.SetFederationError(ctx, store.SetFederationErrorParams{ID: id, LastError: ""}); err != nil {
			return err
		}
		return q.DeleteFederationDeliveries(ctx, ids)
	})
	return n, err
}
