// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"golang.org/x/crypto/argon2"
	"golang.org/x/sync/semaphore"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Guest links: someone from outside joins one channel for a while with a
// password, as a guest of the workspace, without an account at Cenacle ID.
const (
	CodeGuestLinkInvalid = "guest_link_invalid"
	CodeWrongPassword    = "wrong_password"
	// guestTries is how many joins a link takes from one address per window.
	guestTries      = 10
	guestTryWindow  = 10 * time.Minute
	maxGuestLinkTTL = 720 * time.Hour
)

// Argon2id with the parameters OWASP recommends for interactive logins.
const (
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

// guestHashBudget bounds the memory (KiB) that guest-password hashing takes
// at once, across the server: each hash holds its m KiB while it runs, and
// joining needs no account. Hashes wait for room up to guestHashWait.
const (
	guestHashBudget = 4 * argonMemory
	guestHashWait   = 5 * time.Second
)

var (
	guestHashing = semaphore.NewWeighted(guestHashBudget)
	// guestArgon is argon2.IDKey (a variable for tests).
	guestArgon = argon2.IDKey
	// errHashBusy: no room to hash a guest password in time.
	errHashBusy = errors.New("guest password hashing is busy")
)

// argonBounded runs Argon2id within guestHashBudget.
func argonBounded(ctx context.Context, password, salt []byte, t, m uint32, p uint8, keyLen uint32) ([]byte, error) {
	weight := min(int64(m), guestHashBudget)
	ctx, cancel := context.WithTimeout(ctx, guestHashWait)
	defer cancel()
	if err := guestHashing.Acquire(ctx, weight); err != nil {
		return nil, errHashBusy
	}
	defer guestHashing.Release(weight)
	return guestArgon(password, salt, t, m, p, keyLen), nil
}

func hashGuestPassword(ctx context.Context, password string) (string, error) {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key, err := argonBounded(ctx, []byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if err != nil {
		return "", err
	}
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads,
		enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// checkGuestPassword says whether password matches; errHashBusy when there
// was no room to hash it.
func checkGuestPassword(ctx context.Context, encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, nil
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil || m > 256*1024 || t > 10 || p == 0 {
		return false, nil
	}
	enc := base64.RawStdEncoding
	salt, err1 := enc.DecodeString(parts[4])
	want, err2 := enc.DecodeString(parts[5])
	if err1 != nil || err2 != nil || len(want) == 0 || len(want) > 64 {
		return false, nil
	}
	got, err := argonBounded(ctx, []byte(password), salt, t, m, p, uint32(len(want))) //nolint:gosec // at most 64
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// hashingBusy answers that guest passwords cannot be checked right now.
func hashingBusy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Retry-After", "1")
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: httpx.CodeUnavailable,
		Detail: "The server is busy; try again in a moment."})
}

func guestLinkAPI(l store.GuestLink, guests int) api.GuestLink {
	out := api.GuestLink{Id: uuid(l.ID), Name: l.Name, CreatedAt: l.CreatedAt, ExpiresAt: l.ExpiresAt,
		Uses: int(l.Uses), Guests: guests}
	if l.MaxUses.Valid {
		out.MaxUses = ptr(int(l.MaxUses.Int32))
	}
	return out
}

// guestLinkChannel loads a channel whose guest links the user manages.
func (h *Handlers) guestLinkChannel(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID, user store.User) (store.Channel, bool) {
	c, role, ok := h.visibleChannel(w, r, channelID, user)
	if !ok {
		return c, false
	}
	switch {
	case !canManage(c, role):
		forbidden(w, r, httpx.CodeForbidden, "Only the channel's managers manage its guest links.")
		return c, false
	case c.Encrypted || c.ArchivedAt.Valid:
		forbidden(w, r, httpx.CodeForbidden, "Encrypted and archived channels have no guest links.")
		return c, false
	case len(accessRules(c)) > 0: // link guests have no attributes
		forbidden(w, r, CodeAccessRules, "Channels with access rules have no guest links.")
		return c, false
	case c.GroupManaged: // nor directory groups
		forbidden(w, r, CodeGroupManaged, "Channels managed by groups have no guest links.")
		return c, false
	}
	scheme, ok := h.schemeOf(w, r, c)
	if !ok {
		return c, false
	}
	if !scheme.Allows(PermGuestLinks, role.ws) {
		forbidden(w, r, httpx.CodeForbidden, "Your role in this workspace does not create guest links.")
		return c, false
	}
	return c, true
}

// ListGuestLinks implements api.ServerInterface.
func (h *Handlers) ListGuestLinks(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.guestLinkChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	rows, err := h.Queries.ListGuestLinks(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list guest links", err)
		return
	}
	out := make([]api.GuestLink, 0, len(rows))
	for _, l := range rows {
		out = append(out, guestLinkAPI(store.GuestLink{ID: l.ID, ChannelID: l.ChannelID, Name: l.Name, CreatedAt: l.CreatedAt,
			ExpiresAt: l.ExpiresAt, MaxUses: l.MaxUses, Uses: l.Uses}, int(l.Guests)))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Links []api.GuestLink `json:"links"`
	}{out})
}

// CreateGuestLink implements api.ServerInterface.
func (h *Handlers) CreateGuestLink(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.CreateGuestLinkJSONBody
	if !decode(w, r, &in) {
		return
	}
	c, ok := h.guestLinkChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	name := strings.TrimSpace(deref1(in.Name))
	ttl := time.Duration(in.ExpiresInHours) * time.Hour
	switch {
	case utf8.RuneCountInString(name) > 80:
		badRequest(w, r, "A link's name has at most 80 characters.")
		return
	case ttl < time.Hour || ttl > maxGuestLinkTTL:
		badRequest(w, r, "expires_in_hours is 1 to 720.")
		return
	case utf8.RuneCountInString(in.Password) < 8 || len(in.Password) > 200:
		badRequest(w, r, "The password has 8 to 200 characters.")
		return
	case in.MaxUses != nil && (*in.MaxUses < 1 || *in.MaxUses > 1000):
		badRequest(w, r, "max_uses is 1 to 1000.")
		return
	}
	var maxUses pgtype.Int4
	if in.MaxUses != nil {
		maxUses = pgtype.Int4{Int32: int32(*in.MaxUses), Valid: true} //nolint:gosec // checked above
	}
	passwordHash, err := hashGuestPassword(r.Context(), in.Password)
	if err != nil {
		hashingBusy(w, r)
		return
	}
	token := randomToken()
	link, err := h.Queries.CreateGuestLink(r.Context(), store.CreateGuestLinkParams{
		ChannelID: c.ID, Name: name, TokenHash: hashToken(token), PasswordHash: passwordHash,
		CreatedBy: p.User.ID, ExpiresAt: time.Now().Add(ttl), MaxUses: maxUses,
	})
	if err != nil {
		h.unavailable(w, r, "create guest link", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.GuestLinkCreated, "channel", uuid(c.ID).String(), map[string]any{
		"channel": c.Name, "name": name, "expires_at": link.ExpiresAt,
	})
	httpx.WriteJSON(w, http.StatusCreated, struct {
		Link  api.GuestLink `json:"link"`
		Token string        `json:"token"`
	}{guestLinkAPI(link, 0), token})
}

// RevokeGuestLink implements api.ServerInterface.
func (h *Handlers) RevokeGuestLink(w http.ResponseWriter, r *http.Request, channelID, linkID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.guestLinkChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		n, err := q.RevokeGuestLink(r.Context(), store.RevokeGuestLinkParams{ID: pgUUID(linkID), ChannelID: c.ID})
		if err != nil {
			return err
		}
		if n == 0 {
			return errNoLink
		}
		if _, err := q.EndLinkGuests(r.Context()); err != nil {
			return err
		}
		return q.DeleteLinkGuestSessions(r.Context())
	})
	if errors.Is(err, errNoLink) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such guest link."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "revoke guest link", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.GuestLinkRevoked, "channel", uuid(c.ID).String(), map[string]any{
		"channel": c.Name, "link": linkID.String(),
	})
	h.publish(r.Context(), events.ChannelMembersChanged, ChannelEvent{ChannelID: uuid(c.ID).String()})
	w.WriteHeader(http.StatusNoContent)
}

var errNoLink = errors.New("no such guest link")

func (h *Handlers) guestLink(w http.ResponseWriter, r *http.Request, token string) (store.GetGuestLinkByHashRow, bool) {
	l, err := h.Queries.GetGuestLinkByHash(r.Context(), hashToken(token))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such guest link."})
		return l, false
	}
	if err != nil {
		h.unavailable(w, r, "get guest link", err)
		return l, false
	}
	return l, true
}

func linkUsable(l store.GetGuestLinkByHashRow) bool {
	return !l.RevokedAt.Valid && l.ExpiresAt.After(time.Now()) && (!l.MaxUses.Valid || l.Uses < l.MaxUses.Int32)
}

// GetGuestLink implements api.ServerInterface.
func (h *Handlers) GetGuestLink(w http.ResponseWriter, r *http.Request, token string) {
	l, ok := h.guestLink(w, r, token)
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.GuestLinkPreview{ChannelName: l.ChannelName, WorkspaceName: l.WorkspaceName,
		Valid: linkUsable(l), ExpiresAt: l.ExpiresAt})
}

// JoinGuestLink implements api.ServerInterface.
func (h *Handlers) JoinGuestLink(w http.ResponseWriter, r *http.Request, token string) {
	var in api.JoinGuestLinkJSONBody
	if !decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 80 {
		badRequest(w, r, "Your name has 1 to 80 characters.")
		return
	}
	if h.Sessions == nil {
		forbidden(w, r, CodeGuestLinkInvalid, "Guest links are not available on this server.")
		return
	}
	l, ok := h.guestLink(w, r, token)
	if !ok {
		return
	}
	if !linkUsable(l) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusGone, Code: CodeGuestLinkInvalid,
			Detail: "This guest link expired, was used up or was revoked."})
		return
	}
	ip := auth.ClientIP(r, h.TrustProxy)
	if h.Limiter != nil {
		n, wait, err := h.Limiter.Hit(r.Context(), "cenacle:rl:guestlink:"+uuid(l.ID).String()+":"+ip, guestTryWindow)
		if err != nil {
			h.unavailable(w, r, "rate limit", err)
			return
		}
		if n > guestTries {
			w.Header().Set("Retry-After", fmt.Sprint(max(1, int(wait.Seconds()))))
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
				Detail: "Too many tries; wait a while."})
			return
		}
	}
	match, err := checkGuestPassword(r.Context(), l.PasswordHash, in.Password)
	if err != nil {
		hashingBusy(w, r)
		return
	}
	if !match {
		forbidden(w, r, CodeWrongPassword, "The password is not right.")
		return
	}
	c, err := h.Queries.GetChannel(r.Context(), l.ChannelID)
	if err != nil {
		h.unavailable(w, r, "get channel", err)
		return
	}
	// Rules or groups may have come after the link.
	if len(accessRules(c)) > 0 {
		forbidden(w, r, CodeAccessRules, "This channel is for members with certain attributes (e.g. department).")
		return
	}
	if c.GroupManaged {
		forbidden(w, r, CodeGroupManaged, "Membership of this channel follows directory groups.")
		return
	}
	var guest store.User
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if _, err := q.UseGuestLink(r.Context(), l.ID); err != nil {
			return err
		}
		var err error
		guest, err = q.CreateLinkGuest(r.Context(), store.CreateLinkGuestParams{
			AuthData: "link:" + uuid(l.ID).String() + ":" + randomToken(), DisplayName: name, GuestLinkID: l.ID,
		})
		if err != nil {
			return err
		}
		if _, err := q.AddWorkspaceMember(r.Context(), store.AddWorkspaceMemberParams{WorkspaceID: c.WorkspaceID, UserID: guest.ID, Role: WorkspaceGuest}); err != nil {
			return err
		}
		_, err = q.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: guest.ID, Role: RoleMember})
		return err
	})
	if isNoRows(err) { // used up in between
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusGone, Code: CodeGuestLinkInvalid,
			Detail: "This guest link expired, was used up or was revoked."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "join guest link", err)
		return
	}
	sessionToken, sess, err := h.Sessions.CreateUntil(r.Context(), guest.ID, auth.ClientInfo{UserAgent: r.UserAgent(), IP: ip}, l.ExpiresAt)
	if errors.Is(err, auth.ErrNetworkNotAllowed) {
		forbidden(w, r, "network", "Sign-in from this network is not allowed.")
		return
	}
	if err != nil {
		h.unavailable(w, r, "start session", err)
		return
	}
	h.Cookies.SetSession(w, sessionToken, sess.ExpiresAt)
	h.Audit.Record(context.WithoutCancel(r.Context()), audit.Event{Actor: guest.ID, Workspace: c.WorkspaceID,
		Action: audit.GuestLinkJoined, TargetType: "channel", TargetID: uuid(c.ID).String(), IP: ip,
		Detail: map[string]any{"channel": c.Name, "name": name, "link": uuid(l.ID).String()}})
	h.membersChanged(r.Context(), c, guest.ID, events.ChannelJoined, toAPI(c, access{ch: RoleMember, ws: WorkspaceGuest}))
	h.channelLine(r.Context(), c, LineJoined, guest.ID, guest.ID)
	httpx.WriteJSON(w, http.StatusCreated, struct {
		ChannelID openapi_types.UUID `json:"channel_id"`
	}{uuid(c.ID)})
}
