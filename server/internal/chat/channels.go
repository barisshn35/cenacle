// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Channel kinds.
const (
	KindStandard     = "standard"
	KindAnnouncement = "announcement"
)

// Problem codes of channel operations.
const (
	CodeNotAMember       = "not_a_member"
	CodeReadOnlyChannel  = "read_only_channel"
	CodeChannelMandatory = "channel_mandatory"
	CodeNameTaken        = "channel_name_taken"
)

// Limits of channel fields (characters).
const (
	MaxChannelName = 80
	MaxTopic       = 250
)

// canPost: everyone in standard channels, only the administrator in
// announcement channels.
func canPost(c store.Channel, user store.User) bool {
	return c.Kind != KindAnnouncement || user.IsAdmin
}

func toAPI(c store.Channel, member bool, user store.User) api.Channel {
	return api.Channel{
		Id: uuid(c.ID), Name: c.Name, Topic: c.Topic, Kind: api.ChannelKind(c.Kind),
		IsDefault: c.IsDefault, IsMandatory: c.IsMandatory, IsMember: member,
		CanPost: member && canPost(c, user),
	}
}

func writeChannels(w http.ResponseWriter, list []api.Channel) {
	httpx.WriteJSON(w, http.StatusOK, api.ChannelList{Channels: list})
}

// ListChannels implements api.ServerInterface.
func (h *Handlers) ListChannels(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListMemberChannels(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list channels", err)
		return
	}
	out := make([]api.Channel, 0, len(rows))
	for _, c := range rows {
		out = append(out, toAPI(c, true, p.User))
	}
	writeChannels(w, out)
}

// ListChannelDirectory implements api.ServerInterface.
func (h *Handlers) ListChannelDirectory(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rows, err := h.Queries.ListAllChannels(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "list channel directory", err)
		return
	}
	out := make([]api.Channel, 0, len(rows))
	for _, c := range rows {
		ch := store.Channel{ID: c.ID, Name: c.Name, Topic: c.Topic, Kind: c.Kind,
			IsDefault: c.IsDefault, IsMandatory: c.IsMandatory}
		out = append(out, toAPI(ch, c.IsMember, p.User))
	}
	writeChannels(w, out)
}

// cleanName trims a channel name and checks it.
func cleanName(name string) (string, string) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", "The channel name is empty."
	case utf8.RuneCountInString(name) > MaxChannelName:
		return "", "The channel name is longer than 80 characters."
	case !utf8.ValidString(name) || strings.ContainsFunc(name, unicode.IsControl):
		return "", "The channel name contains invalid characters."
	}
	return name, ""
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// CreateChannel implements api.ServerInterface.
func (h *Handlers) CreateChannel(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !p.User.IsAdmin {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: httpx.CodeForbidden,
			Detail: "Only the administrator can create channels."})
		return
	}
	var in api.NewChannel
	if !decode(w, r, &in) {
		return
	}
	name, problem := cleanName(in.Name)
	topic := ""
	if in.Topic != nil {
		topic = strings.TrimSpace(*in.Topic)
	}
	kind := KindStandard
	if in.Kind != nil {
		kind = string(*in.Kind)
	}
	switch {
	case problem != "":
	case utf8.RuneCountInString(topic) > MaxTopic || strings.ContainsFunc(topic, unicode.IsControl):
		problem = "The topic is longer than 250 characters or contains invalid characters."
	case kind != KindStandard && kind != KindAnnouncement:
		problem = "kind must be standard or announcement."
	}
	if problem != "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest, Detail: problem})
		return
	}
	isDefault := in.IsDefault != nil && *in.IsDefault

	c, err := h.Queries.CreateChannel(r.Context(), store.CreateChannelParams{
		Name: name, Topic: topic, Kind: kind, IsDefault: isDefault, CreatedBy: p.User.ID,
	})
	if isUniqueViolation(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeNameTaken,
			Detail: "A channel with this name exists."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "create channel", err)
		return
	}
	if isDefault {
		_, err = h.Queries.AddAllUsers(r.Context(), c.ID)
	} else {
		_, err = h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: p.User.ID})
	}
	if err != nil {
		h.unavailable(w, r, "add channel members", err)
		return
	}
	out := toAPI(c, true, p.User)
	if isDefault {
		h.publish(r.Context(), events.ChannelCreated, ChannelEvent{Channel: out})
	} else {
		h.publish(r.Context(), events.ChannelJoined, ChannelEvent{Channel: out, UserID: uuid(p.User.ID).String()})
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
}

// ChannelEvent is the data of channel.created (a default channel, for
// everyone), channel.joined and channel.left (for UserID).
type ChannelEvent struct {
	Channel api.Channel `json:"channel"`
	UserID  string      `json:"user_id,omitempty"`
}

// JoinChannel implements api.ServerInterface.
func (h *Handlers) JoinChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.channel(w, r, channelID)
	if !ok {
		return
	}
	n, err := h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "join channel", err)
		return
	}
	out := toAPI(c, true, p.User)
	if n > 0 {
		h.publish(r.Context(), events.ChannelJoined, ChannelEvent{Channel: out, UserID: uuid(p.User.ID).String()})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// LeaveChannel implements api.ServerInterface.
func (h *Handlers) LeaveChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.channel(w, r, channelID)
	if !ok {
		return
	}
	if c.IsMandatory {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: CodeChannelMandatory,
			Detail: "Everyone is a member of this channel."})
		return
	}
	n, err := h.Queries.RemoveMember(r.Context(), store.RemoveMemberParams{ChannelID: c.ID, UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "leave channel", err)
		return
	}
	if n > 0 {
		h.publish(r.Context(), events.ChannelLeft, ChannelEvent{
			Channel: toAPI(c, false, p.User), UserID: uuid(p.User.ID).String(),
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// member answers 403 unless the user belongs to the channel.
func (h *Handlers) member(w http.ResponseWriter, r *http.Request, c store.Channel, user store.User) bool {
	ok, err := h.Queries.IsMember(r.Context(), store.IsMemberParams{ChannelID: c.ID, UserID: user.ID})
	if err != nil {
		h.unavailable(w, r, "check membership", err)
		return false
	}
	if !ok {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: CodeNotAMember,
			Detail: "Join the channel first."})
	}
	return ok
}

func (h *Handlers) publish(ctx context.Context, typ string, data any) {
	if _, err := h.Events.Append(ctx, typ, data); err != nil {
		h.Log.ErrorContext(ctx, "append event", "type", typ, "error", err,
			"request_id", httpx.RequestIDFrom(ctx))
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "The body is not valid JSON for this operation."})
		return false
	}
	return true
}

// Defaults are the channels configured at installation.
type Defaults struct {
	Announcement string
	Channels     []string
	AdminEmail   string
}

// EnsureDefaults creates the configured channels (or brings existing ones to
// the configured kind), makes every user a member of the default channels and
// takes the administrator flag from users whose address is no longer
// configured. It is safe to run on every start of every instance.
func EnsureDefaults(ctx context.Context, q store.Querier, d Defaults) error {
	type spec struct {
		name, topic, kind string
		mandatory         bool
	}
	var specs []spec
	if d.Announcement != "" {
		specs = append(specs, spec{d.Announcement, "Announcements for everyone.", KindAnnouncement, true})
	}
	for _, name := range d.Channels {
		specs = append(specs, spec{name, "", KindStandard, false})
	}
	for _, s := range specs {
		c, err := q.EnsureChannel(ctx, store.EnsureChannelParams{
			Name: s.name, Topic: s.topic, Kind: s.kind, IsDefault: true, IsMandatory: s.mandatory,
		})
		if err != nil {
			return fmt.Errorf("ensure channel %q: %w", s.name, err)
		}
		if _, err := q.AddAllUsers(ctx, c.ID); err != nil {
			return fmt.Errorf("members of %q: %w", s.name, err)
		}
	}
	if err := q.RevokeAdminUnlessEmail(ctx, d.AdminEmail); err != nil {
		return fmt.Errorf("administrator: %w", err)
	}
	return nil
}

// RunEnsureDefaults retries EnsureDefaults until it succeeds or ctx ends: the
// server starts even while the database is down.
func RunEnsureDefaults(ctx context.Context, q store.Querier, d Defaults, log *slog.Logger) {
	backoff := time.Second
	for {
		err := EnsureDefaults(ctx, q, d)
		if err == nil {
			log.Info("default channels ready", "announcement", d.Announcement, "default", d.Channels)
			if d.AdminEmail == "" {
				log.Warn("no administrator configured (CENACLE_ADMIN_EMAIL): nobody can create channels")
			}
			return
		}
		log.Warn("default channels not ready", "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
