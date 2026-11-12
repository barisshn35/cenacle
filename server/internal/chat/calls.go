// SPDX-License-Identifier: AGPL-3.0-only
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/cache"
	"github.com/Cenacle-TR/cenacle/server/internal/config"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/media"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

var errCallConflict = errors.New("call state conflict")

type CallControl struct {
	Config *config.Calls
	Cache  *cache.Client
	Tokens *media.Tokens
}

func NewCallControl(c *config.Calls, issuer string, client *cache.Client) *CallControl {
	if c == nil {
		return nil
	}
	return &CallControl{Config: c, Cache: client, Tokens: &media.Tokens{Private: c.Private, KeyID: c.KeyID, Issuer: strings.TrimSuffix(issuer, "/"), Store: client}}
}

func (c *CallControl) node(ctx context.Context) (pgtype.UUID, error) {
	var id pgtype.UUID
	client, err := c.Cache.Get()
	if err != nil {
		return id, err
	}
	raw, err := client.Do(ctx, client.B().Get().Key("cenacle:media:node:"+c.Config.NodeID).Build()).ToString()
	if err != nil {
		return id, err
	}
	parsed, err := guuid.Parse(raw)
	if err != nil || parsed == guuid.Nil {
		return id, errCallConflict
	}
	return pgUUID(parsed), nil
}

// callView deliberately excludes session identifiers, node internals and
// admission data. It is also the state-event payload after adding channel_id.
type callView struct {
	ID           openapi_types.UUID    `json:"id"`
	ChannelID    openapi_types.UUID    `json:"channel_id"`
	State        string                `json:"state"`
	Revision     int64                 `json:"revision"`
	CreatedAt    time.Time             `json:"created_at"`
	RingUntil    *time.Time            `json:"ring_until"`
	StartedAt    *time.Time            `json:"started_at"`
	EndedAt      *time.Time            `json:"ended_at"`
	EndReason    string                `json:"end_reason"`
	Participants []callParticipantView `json:"participants"`
	CaptionsOn   bool                  `json:"captions_on"`
	CaptionsBy   *openapi_types.UUID   `json:"captions_by"`
	NotesOn      bool                  `json:"notes_on"`
	NotesBy      *openapi_types.UUID   `json:"notes_by"`
}
type callParticipantView struct {
	ID       openapi_types.UUID  `json:"id"`
	UserID   *openapi_types.UUID `json:"user_id"`
	State    string              `json:"state"`
	JoinedAt *time.Time          `json:"joined_at"`
	LeftAt   *time.Time          `json:"left_at"`
	// HandRaisedAt: a raised hand, since when.
	HandRaisedAt *time.Time `json:"hand_raised_at"`
}

func callSnapshot(ctx context.Context, q store.Querier, c store.Call) (callView, error) {
	out := callView{ID: uuid(c.ID), ChannelID: uuid(c.ChannelID), State: c.State, Revision: c.Revision, CreatedAt: c.CreatedAt, RingUntil: timePtr(c.RingUntil), StartedAt: timePtr(c.StartedAt), EndedAt: timePtr(c.EndedAt), EndReason: c.EndReason, Participants: []callParticipantView{}, CaptionsOn: c.CaptionsOn}
	if c.CaptionsBy.Valid {
		by := uuid(c.CaptionsBy)
		out.CaptionsBy = &by
	}
	out.NotesOn = c.NotesOn
	if c.NotesBy.Valid {
		by := uuid(c.NotesBy)
		out.NotesBy = &by
	}
	rows, err := q.ListCallParticipants(ctx, c.ID)
	if err != nil {
		return out, err
	}
	for _, p := range rows {
		if p.RedactedAt.Valid {
			continue
		}
		v := callParticipantView{ID: uuid(p.ID), State: p.State, JoinedAt: timePtr(p.JoinedAt), LeftAt: timePtr(p.LeftAt), HandRaisedAt: timePtr(p.HandRaisedAt)}
		if p.UserID.Valid {
			id := uuid(p.UserID)
			v.UserID = &id
		}
		out.Participants = append(out.Participants, v)
	}
	return out, nil
}
func emitCall(ctx context.Context, q *store.Queries, c store.Call, kind string) error {
	// Calls are local: bypass bot/federation fan-out and use the transactional
	// client outbox. Invalidation events contain no participant identities;
	// clients refetch the current authorized, redacted snapshot. Replayed events
	// cannot resurrect an erased participant from the shared Valkey stream.
	raw, err := json.Marshal(map[string]any{"id": uuid(c.ID), "channel_id": uuid(c.ChannelID), "revision": c.Revision, "needs_refresh": true})
	if err != nil {
		return err
	}
	return q.InsertOutboxEvent(ctx, store.InsertOutboxEventParams{Type: kind, Data: raw})
}

func (h *Handlers) callLimit(w http.ResponseWriter, r *http.Request, p auth.Principal) bool {
	if h.Calls == nil {
		forbidden(w, r, "calls_disabled", "Calls are disabled on this installation.")
		return false
	}
	if h.Limiter == nil {
		h.unavailable(w, r, "call admission", errors.New("rate limiter unavailable"))
		return false
	}
	count, _, err := h.Limiter.Hit(r.Context(), "cenacle:calls:admit:"+uuid(p.User.ID).String(), 10*time.Second)
	if err != nil {
		h.unavailable(w, r, "call admission", err)
		return false
	}
	if count > 12 {
		w.Header().Set("Retry-After", "10")
		httpx.WriteProblem(w, r, httpx.Problem{Status: 429, Code: "rate_limited"})
		return false
	}
	return true
}
func (h *Handlers) callChannel(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, p auth.Principal) (store.Channel, access, bool) {
	c, a, ok := h.memberChannel(w, r, id, p.User)
	if !ok {
		return c, a, false
	}
	if c.Encrypted || c.Mls {
		forbidden(w, r, "calls_encrypted", "Calls are unavailable in encrypted channels because the media server can read media.")
		return c, a, false
	}
	if c.ArchivedAt.Valid {
		forbidden(w, r, CodeChannelArchived, "The channel is archived.")
		return c, a, false
	}
	settings, err := h.Queries.GetCallSettings(r.Context(), c.WorkspaceID)
	if err != nil {
		h.unavailable(w, r, "call settings", err)
		return c, a, false
	}
	if !settings.CallsEnabled {
		forbidden(w, r, "calls_disabled", "Calls are disabled in this workspace.")
		return c, a, false
	}
	return c, a, true
}
func (h *Handlers) callError(w http.ResponseWriter, r *http.Request, err error) {
	var pgerr *pgconn.PgError
	if errors.Is(err, errCallConflict) || (errors.As(err, &pgerr) && pgerr.Code == "23505") {
		httpx.WriteProblem(w, r, httpx.Problem{Status: 409, Code: "call_conflict", Detail: "The call is full, ended, or a participant is already in another call."})
		return
	}
	h.unavailable(w, r, "call operation", err)
}

func (h *Handlers) StartCall(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.callLimit(w, r, p) {
		return
	}
	c, a, ok := h.callChannel(w, r, channelID, p)
	if !ok {
		return
	}
	settings, err := h.Queries.GetCallSettings(r.Context(), c.WorkspaceID)
	if err != nil {
		h.callError(w, r, err)
		return
	}
	if a.ws == WorkspaceGuest && !settings.CallsGuestStart {
		forbidden(w, r, "calls_guest_start_disabled", "Guests cannot start calls in this workspace.")
		return
	}
	if !canPost(c, a) {
		forbidden(w, r, CodeReadOnlyChannel, "You cannot start a call in this channel.")
		return
	}
	if h.timedOut(w, r, c.WorkspaceID, p.User) {
		return
	}
	var in struct {
		Nonce openapi_types.UUID `json:"nonce"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Nonce == guuid.Nil {
		badRequest(w, r, "A nonzero nonce is required.")
		return
	}
	node, err := h.Calls.node(r.Context())
	if err != nil {
		h.callError(w, r, err)
		return
	}
	var call store.Call
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		if e := q.LockCallCreation(r.Context()); e != nil {
			return e
		}
		if previous, e := q.GetCallByNonce(r.Context(), store.GetCallByNonceParams{ChannelID: c.ID, Nonce: pgUUID(in.Nonce)}); e == nil {
			if previous.CreatedBy != p.User.ID {
				return errCallConflict
			}
			call = previous
			return nil
		} else if !isNoRows(e) {
			return e
		}
		count, countErr := q.CountOpenCalls(r.Context())
		if countErr != nil {
			return countErr
		}
		if count >= 32 {
			return errCallConflict
		}
		state := "active"
		var ring pgtype.Timestamptz
		if c.Kind == KindDirect {
			state = "ringing"
			ring = pgtype.Timestamptz{Time: time.Now().Add(30 * time.Second), Valid: true}
		}
		var e error
		call, e = q.CreateCall(r.Context(), store.CreateCallParams{ChannelID: c.ID, CreatedBy: p.User.ID, Nonce: pgUUID(in.Nonce), State: state, RingUntil: ring, NodeID: h.Calls.Config.NodeID, NodeGeneration: node})
		if e != nil {
			return e
		}
		if e = q.ExpireUserCallReservation(r.Context(), p.User.ID); e != nil {
			return e
		}
		if _, e = q.ReserveCallParticipant(r.Context(), store.ReserveCallParticipantParams{CallID: call.ID, UserID: p.User.ID, SessionID: p.Session.ID}); e != nil {
			return e
		}
		if c.Kind == KindDirect {
			members, e := q.ListMembers(r.Context(), c.ID)
			if e != nil {
				return e
			}
			for _, member := range members {
				if member.ID == p.User.ID {
					continue
				}
				if e = q.ExpireUserCallReservation(r.Context(), member.ID); e != nil {
					return e
				}
				if _, e = q.GetOpenUserCallParticipant(r.Context(), member.ID); e == nil {
					call, e = endCall(r.Context(), q, call, "busy")
					return e
				} else if !isNoRows(e) {
					return e
				}
			}
		}
		kind := events.CallParticipants
		if state == "ringing" {
			kind = events.CallRinging
		}
		return emitCall(r.Context(), q, call, kind)
	})
	if err != nil {
		var unique *pgconn.PgError
		if errors.As(err, &unique) && unique.Code == "23505" {
			previous, e := h.Queries.GetCallByNonce(r.Context(), store.GetCallByNonceParams{ChannelID: c.ID, Nonce: pgUUID(in.Nonce)})
			if e == nil && previous.CreatedBy == p.User.ID {
				h.writeCall(w, r, previous, http.StatusCreated)
				return
			}
		}
		h.callError(w, r, err)
		return
	}
	if !call.EndedAt.Valid { // a call to someone busy ends at once and never started
		h.record(r, c.WorkspaceID, "call.started", "call", uuid(call.ID).String(), nil)
	}
	h.writeCall(w, r, call, http.StatusCreated)
}

func (h *Handlers) writeCall(w http.ResponseWriter, r *http.Request, c store.Call, status int) {
	snapshot, err := callSnapshot(r.Context(), h.Queries, c)
	if err != nil {
		h.callError(w, r, err)
		return
	}
	httpx.WriteJSON(w, status, snapshot)
}
func (h *Handlers) GetChannelCall(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, _, ok = h.memberChannel(w, r, channelID, p.User); !ok {
		return
	}
	c, err := h.Queries.GetChannelCall(r.Context(), pgUUID(channelID))
	if isNoRows(err) {
		// No call is the usual answer, not an error (browsers log every 4xx).
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.callError(w, r, err)
		return
	}
	h.writeCall(w, r, c, 200)
}
func (h *Handlers) accessibleCall(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, p auth.Principal) (store.Call, bool) {
	c, err := h.Queries.GetCall(r.Context(), pgUUID(id))
	if isNoRows(err) {
		channelNotFound(w, r)
		return c, false
	}
	if err != nil {
		h.callError(w, r, err)
		return c, false
	}
	_, _, ok := h.memberChannel(w, r, uuid(c.ChannelID), p.User)
	return c, ok
}
func (h *Handlers) GetCall(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, ok := h.accessibleCall(w, r, id, p)
	if ok {
		h.writeCall(w, r, c, 200)
	}
}

func (h *Handlers) CreateCallToken(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	w.Header().Set("Cache-Control", "no-store")
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	denied := true
	var auditWorkspace pgtype.UUID
	defer func() {
		if !denied {
			return
		}
		// Refused before the channel was known (rate limit, no access): the call's own workspace.
		if !auditWorkspace.Valid {
			if c, e := h.Queries.GetCall(r.Context(), pgUUID(id)); e == nil {
				if ch, e := h.Queries.GetChannel(r.Context(), c.ChannelID); e == nil {
					auditWorkspace = ch.WorkspaceID
				}
			}
		}
		if auditWorkspace.Valid {
			h.record(r, auditWorkspace, "call.token_denied", "call", id.String(), nil)
		}
	}()
	if !h.callLimit(w, r, p) {
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	channel, _, ok := h.callChannel(w, r, uuid(call.ChannelID), p)
	auditWorkspace = channel.WorkspaceID
	if !ok {
		return
	}
	node, err := h.Calls.node(r.Context())
	if err != nil {
		h.callError(w, r, err)
		return
	}
	var participant store.CallParticipant
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		locked, e := q.LockCall(r.Context(), call.ID)
		if e != nil {
			return e
		}
		call = locked
		if call.EndedAt.Valid || call.NodeGeneration != node || (call.State == "ringing" && (call.CreatedBy != p.User.ID || !call.RingUntil.Valid || !call.RingUntil.Time.After(time.Now()))) {
			return errCallConflict
		}
		if _, e = q.ExpireDisconnectedCallParticipants(r.Context(), call.ID); e != nil {
			return e
		}
		if e = q.ExpireUserCallReservation(r.Context(), p.User.ID); e != nil {
			return e
		}
		existing, e := q.GetOpenUserCallParticipant(r.Context(), p.User.ID)
		if e == nil {
			if existing.CallID != call.ID || existing.SessionID != p.Session.ID {
				return errCallConflict
			}
			participant = existing
			return nil
		}
		if !isNoRows(e) {
			return e
		}
		settings, e := q.GetCallSettings(r.Context(), channel.WorkspaceID)
		if e != nil {
			return e
		}
		if !settings.CallsEnabled {
			return errCallConflict
		}
		count, e := q.CountOpenCallParticipants(r.Context(), call.ID)
		if e != nil {
			return e
		}
		if count >= int64(settings.CallsMaxParticipants) {
			return errCallConflict
		}
		participant, e = q.ReserveCallParticipant(r.Context(), store.ReserveCallParticipantParams{CallID: call.ID, UserID: p.User.ID, SessionID: p.Session.ID})
		return e
	})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	token, err := h.Calls.Tokens.Issue(r.Context(), media.Grant{UserID: uuid(p.User.ID).String(), CallID: id.String(), ParticipantID: uuid(participant.ID).String(), SessionID: uuid(p.Session.ID).String(), NodeGeneration: uuid(call.NodeGeneration).String()})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	response := map[string]any{"token": token, "expires_in": 60, "signaling_path": "/media/ws", "participant_id": uuid(participant.ID)}
	if h.Calls.Config.TURNSecret != "" {
		ice, err := media.TURNServerCredentials(h.Calls.Config.TURNSecret, h.Calls.Config.TURNURLs, uuid(participant.ID).String(), time.Now())
		if err != nil {
			h.callError(w, r, err)
			return
		}
		response["ice_servers"] = []media.ICEServer{ice}
	}
	denied = false
	httpx.WriteJSON(w, 200, response)
}

func (h *Handlers) AnswerCall(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.callLimit(w, r, p) {
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	channel, _, ok := h.callChannel(w, r, uuid(call.ChannelID), p)
	if !ok {
		return
	}
	if channel.Kind != KindDirect || call.CreatedBy == p.User.ID {
		forbidden(w, r, "call_answer_denied", "Only the other person can answer a direct call.")
		return
	}
	var in struct {
		Answer string `json:"answer"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Answer != "accept" && in.Answer != "decline" {
		badRequest(w, r, "Answer must be accept or decline.")
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var e error
		call, e = q.LockCall(r.Context(), call.ID)
		if e != nil {
			return e
		}
		if call.State != "ringing" || !call.RingUntil.Valid || !call.RingUntil.Time.After(time.Now()) {
			return errCallConflict
		}
		if in.Answer == "decline" {
			call, e = endCall(r.Context(), q, call, "declined")
			return e
		}
		if e = q.ExpireUserCallReservation(r.Context(), p.User.ID); e != nil {
			return e
		}
		existing, e := q.GetOpenUserCallParticipant(r.Context(), p.User.ID)
		if e == nil && existing.CallID != call.ID {
			call, e = endCall(r.Context(), q, call, "busy")
			return e
		}
		if e != nil && !isNoRows(e) {
			return e
		}
		call, e = q.ActivateCall(r.Context(), call.ID)
		if e != nil {
			return e
		}
		connected, e := q.CountConnectedCallParticipants(r.Context(), call.ID)
		if e != nil {
			return e
		}
		if connected > 0 {
			call, e = q.StartConnectedCall(r.Context(), call.ID)
			if e != nil {
				return e
			}
			return emitCall(r.Context(), q, call, events.CallStarted)
		}
		return emitCall(r.Context(), q, call, events.CallParticipants)
	})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	h.writeCall(w, r, call, 200)
}
func (h *Handlers) LeaveCall(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	call, ok := h.accessibleCall(w, r, id, p)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		locked, e := q.LockCall(r.Context(), call.ID)
		if e != nil {
			return e
		}
		call = locked
		if call.EndedAt.Valid {
			return nil
		}
		changed, e := q.ForceLeaveCallUser(r.Context(), store.ForceLeaveCallUserParams{CallID: call.ID, UserID: p.User.ID})
		if e != nil || changed == 0 {
			return e
		}
		count, e := q.CountOpenCallParticipants(r.Context(), call.ID)
		if e != nil {
			return e
		}
		if count == 0 || call.State == "ringing" {
			_, e = endCall(r.Context(), q, call, "left")
			return e
		}
		call, e = q.BumpCallRevision(r.Context(), call.ID)
		if e != nil {
			return e
		}
		return emitCall(r.Context(), q, call, events.CallLeft)
	})
	if err != nil {
		h.callError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func endCall(ctx context.Context, q *store.Queries, c store.Call, reason string) (store.Call, error) {
	if c.EndedAt.Valid {
		return c, nil
	}
	ended, err := q.EndCall(ctx, store.EndCallParams{ID: c.ID, EndReason: reason})
	if err != nil {
		return c, err
	}
	if err = q.CloseCallParticipants(ctx, c.ID); err != nil {
		return c, err
	}
	if err = callSummary(ctx, q, ended); err != nil {
		return c, err
	}
	return ended, emitCall(ctx, q, ended, events.CallEnded)
}
