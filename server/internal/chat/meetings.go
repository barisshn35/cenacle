// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/events"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/meetings"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Meetings and calendar (ADR 0054).

// Limits of meetings.
const (
	MaxMeetingInvitees = 50
	maxCalendarRange   = 62 * 24 * time.Hour
	// The subscription shows the past month and the next 6 months.
	feedPast   = 31 * 24 * time.Hour
	feedFuture = 183 * 24 * time.Hour
)

// MeetingMailer sends an administrator a sample invitation.
type MeetingMailer interface {
	SendSample(ctx context.Context, to, name, language, timezone string) error
}

// MeetingEvent is the data of a meeting.changed event.
type MeetingEvent struct {
	To        []string `json:"to"`
	MeetingID string   `json:"meeting_id"`
}

type meetingFields struct {
	title, agenda, timezone, rule string
	start, end, last              time.Time
}

// meetingInput checks a meeting's title, time and repeat.
func meetingInput(w http.ResponseWriter, r *http.Request, in api.MeetingInput) (meetingFields, bool) {
	f := meetingFields{title: strings.TrimSpace(in.Title), timezone: in.Timezone, start: in.StartsAt, end: in.EndsAt}
	if in.Agenda != nil {
		f.agenda = strings.TrimSpace(*in.Agenda)
	}
	if in.Rrule != nil {
		f.rule = strings.TrimSpace(*in.Rrule)
	}
	switch {
	case f.title == "" || len([]rune(f.title)) > 200:
		badRequest(w, r, "A meeting has a title of 1 to 200 characters.")
		return f, false
	case len([]rune(f.agenda)) > 4000:
		badRequest(w, r, "The agenda is at most 4000 characters.")
		return f, false
	case !f.end.After(f.start) || f.end.Sub(f.start) > 24*time.Hour:
		badRequest(w, r, "A meeting ends after it starts, within 24 hours.")
		return f, false
	}
	loc, err := time.LoadLocation(f.timezone)
	if err != nil || f.timezone == "" || f.timezone == "Local" {
		badRequest(w, r, "Unknown time zone.")
		return f, false
	}
	rule, err := meetings.ParseRule(f.rule)
	if err != nil {
		badRequest(w, r, meetings.RuleHelp(err))
		return f, false
	}
	f.rule = rule.String()
	f.start, f.end = f.start.UTC().Truncate(time.Minute), f.end.UTC().Truncate(time.Minute)
	f.last = meetings.LastStart(f.start, loc, rule)
	return f, true
}

// meetingPeople checks the invitees: people of the place (the user left out,
// no repeats, at most MaxMeetingInvitees).
func (h *Handlers) meetingPeople(w http.ResponseWriter, r *http.Request, channel store.Channel, self openapi_types.UUID, ids []openapi_types.UUID) ([]openapi_types.UUID, bool) {
	out := []openapi_types.UUID{}
	for _, id := range ids {
		if id != self && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) > MaxMeetingInvitees {
		badRequest(w, r, "Invite at most 50 people.")
		return nil, false
	}
	for _, id := range out {
		role, err := h.Queries.GetMemberRole(r.Context(), store.GetMemberRoleParams{ChannelID: channel.ID, UserID: pgUUID(id)})
		if err != nil {
			h.unavailable(w, r, "member role", err)
			return nil, false
		}
		if role == "" {
			badRequest(w, r, "Everyone invited must be a member of the meeting's channel or conversation.")
			return nil, false
		}
	}
	return out, true
}

// meetingFor finds a meeting the user is invited to.
func (h *Handlers) meetingFor(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Meeting, string, bool) {
	m, err := h.Queries.GetMeeting(r.Context(), pgUUID(id))
	if err == nil {
		var response string
		response, err = h.Queries.GetMeetingResponse(r.Context(), store.GetMeetingResponseParams{MeetingID: m.ID, UserID: user.ID})
		if err == nil {
			return m, response, true
		}
	}
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such meeting."})
	} else {
		h.unavailable(w, r, "get meeting", err)
	}
	return store.Meeting{}, "", false
}

// mayEditMeeting: its organizer, or an administrator of its workspace.
func (h *Handlers) mayEditMeeting(ctx context.Context, m store.Meeting, user store.User) (bool, error) {
	if m.OrganizerID == user.ID {
		return true, nil
	}
	role, err := h.Queries.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: m.WorkspaceID, UserID: user.ID})
	return isWorkspaceAdmin(role), err
}

func (h *Handlers) editableMeeting(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Meeting, bool) {
	m, _, ok := h.meetingFor(w, r, id, user)
	if !ok {
		return m, false
	}
	may, err := h.mayEditMeeting(r.Context(), m, user)
	if err != nil {
		h.unavailable(w, r, "workspace role", err)
		return m, false
	}
	if !may {
		forbidden(w, r, httpx.CodeForbidden, "Only the organizer or a workspace administrator changes a meeting.")
		return m, false
	}
	if m.CancelledAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "meeting_cancelled", Detail: "The meeting is cancelled."})
		return m, false
	}
	return m, true
}

func (h *Handlers) meetingAPI(ctx context.Context, m store.Meeting, user store.User) (api.Meeting, error) {
	rows, err := h.Queries.ListMeetingInvitees(ctx, m.ID)
	if err != nil {
		return api.Meeting{}, err
	}
	may, err := h.mayEditMeeting(ctx, m, user)
	if err != nil {
		return api.Meeting{}, err
	}
	out := api.Meeting{
		Id: uuid(m.ID), WorkspaceId: uuid(m.WorkspaceID), ChannelId: uuid(m.ChannelID),
		Title: m.Title, Agenda: m.Agenda, StartsAt: m.StartsAt, EndsAt: m.EndsAt, Timezone: m.Timezone,
		Rrule: m.Rrule, Exdates: m.Exdates, Cancelled: m.CancelledAt.Valid, CanEdit: may && !m.CancelledAt.Valid,
		MyResponse: api.MeetingMyResponsePending, Invitees: make([]api.MeetingInvitee, 0, len(rows)),
	}
	if out.Exdates == nil {
		out.Exdates = []time.Time{}
	}
	if m.OrganizerID.Valid {
		id := uuid(m.OrganizerID)
		out.OrganizerId = &id
	}
	for _, i := range rows {
		if i.UserID == user.ID {
			out.MyResponse = api.MeetingMyResponse(i.Response)
		}
		out.Invitees = append(out.Invitees, api.MeetingInvitee{
			UserId: uuid(i.UserID), DisplayName: i.DisplayName, Response: api.MeetingInviteeResponse(i.Response),
			Organizer: i.UserID == m.OrganizerID,
		})
	}
	return out, nil
}

func (h *Handlers) writeMeeting(w http.ResponseWriter, r *http.Request, status int, m store.Meeting, user store.User) {
	out, err := h.meetingAPI(r.Context(), m, user)
	if err != nil {
		h.unavailable(w, r, "meeting", err)
		return
	}
	httpx.WriteJSON(w, status, out)
}

func idsOf(ids []openapi_types.UUID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	return out
}

// CreateMeeting implements api.ServerInterface.
func (h *Handlers) CreateMeeting(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.MeetingCreate
	if !decode(w, r, &in) {
		return
	}
	f, ok := meetingInput(w, r, api.MeetingInput{Title: in.Title, Agenda: in.Agenda, StartsAt: in.StartsAt, EndsAt: in.EndsAt,
		Timezone: in.Timezone, Rrule: in.Rrule, UserIds: in.UserIds})
	if !ok {
		return
	}
	if !f.last.Add(f.end.Sub(f.start)).After(time.Now()) {
		badRequest(w, r, "The meeting is over: plan one still to come.")
		return
	}
	wsRole, ok := h.workspaceRole(w, r, in.WorkspaceId, p.User)
	if !ok {
		return
	}
	if wsRole == WorkspaceGuest {
		forbidden(w, r, httpx.CodeForbidden, "Guests do not plan meetings.")
		return
	}
	var channel store.Channel
	if in.ChannelId != nil {
		c, a, ok := h.callChannel(w, r, *in.ChannelId, p)
		if !ok {
			return
		}
		if uuid(c.WorkspaceID) != in.WorkspaceId {
			badRequest(w, r, "The channel is in another workspace.")
			return
		}
		if !canPost(c, a) {
			forbidden(w, r, CodeReadOnlyChannel, "You cannot start a call in this channel.")
			return
		}
		channel = c
	} else {
		c, _, _, ok := h.openConversation(w, r, in.WorkspaceId, p.User, wsRole, in.UserIds)
		if !ok {
			return
		}
		if _, _, ok := h.callChannel(w, r, uuid(c.ID), p); !ok {
			return
		}
		channel = c
	}
	people, ok := h.meetingPeople(w, r, channel, uuid(p.User.ID), in.UserIds)
	if !ok {
		return
	}
	var m store.Meeting
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		m, err = q.CreateMeeting(r.Context(), store.CreateMeetingParams{
			WorkspaceID: channel.WorkspaceID, ChannelID: channel.ID, OrganizerID: p.User.ID,
			Title: f.title, Agenda: f.agenda, StartsAt: f.start, EndsAt: f.end, Timezone: f.timezone, Rrule: f.rule, LastStart: f.last,
		})
		if err != nil {
			return err
		}
		if _, err := q.AddMeetingInvitee(r.Context(), store.AddMeetingInviteeParams{MeetingID: m.ID, UserID: p.User.ID, Response: "yes"}); err != nil {
			return err
		}
		for _, id := range people {
			if _, err := q.AddMeetingInvitee(r.Context(), store.AddMeetingInviteeParams{MeetingID: m.ID, UserID: pgUUID(id), Response: "pending"}); err != nil {
				return err
			}
			if err := q.QueueMeetingMail(r.Context(), store.QueueMeetingMailParams{MeetingID: m.ID, UserID: pgUUID(id), Kind: "invite"}); err != nil {
				return err
			}
		}
		return emit(r.Context(), q, events.MeetingChanged, MeetingEvent{
			To: append(idsOf(people), uuid(p.User.ID).String()), MeetingID: uuid(m.ID).String(),
		})
	})
	if err != nil {
		h.unavailable(w, r, "create meeting", err)
		return
	}
	h.writeMeeting(w, r, http.StatusCreated, m, p.User)
}

// GetMeeting implements api.ServerInterface.
func (h *Handlers) GetMeeting(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	m, _, ok := h.meetingFor(w, r, id, p.User)
	if !ok {
		return
	}
	h.writeMeeting(w, r, http.StatusOK, m, p.User)
}

// UpdateMeeting implements api.ServerInterface.
func (h *Handlers) UpdateMeeting(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	m, ok := h.editableMeeting(w, r, id, p.User)
	if !ok {
		return
	}
	var in api.MeetingInput
	if !decode(w, r, &in) {
		return
	}
	f, ok := meetingInput(w, r, in)
	if !ok {
		return
	}
	channel, err := h.Queries.GetChannel(r.Context(), m.ChannelID)
	if err != nil {
		h.unavailable(w, r, "meeting channel", err)
		return
	}
	// The organizer stays invited (an administrator changing it is not added).
	self := uuid(m.OrganizerID)
	people, ok := h.meetingPeople(w, r, channel, self, in.UserIds)
	if !ok {
		return
	}
	before, err := h.Queries.ListMeetingInvitees(r.Context(), m.ID)
	if err != nil {
		h.unavailable(w, r, "meeting invitees", err)
		return
	}
	moved := !m.StartsAt.Equal(f.start) || !m.EndsAt.Equal(f.end)
	changed := moved || m.Title != f.title || m.Agenda != f.agenda || m.Rrule != f.rule || m.Timezone != f.timezone
	actor := p.User.ID
	to := []string{}
	var updated store.Meeting
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		updated, err = q.UpdateMeeting(r.Context(), store.UpdateMeetingParams{
			ID: m.ID, Title: f.title, Agenda: f.agenda, StartsAt: f.start, EndsAt: f.end, Timezone: f.timezone, Rrule: f.rule, LastStart: f.last,
		})
		if err != nil {
			return err
		}
		mail := func(user store.ListMeetingInviteesRow, kind string) error {
			arg := store.QueueMeetingMailParams{MeetingID: m.ID, UserID: user.UserID, Kind: kind}
			if kind == "update" && moved {
				arg.WasStartsAt.Time, arg.WasStartsAt.Valid = m.StartsAt, true
				arg.WasEndsAt.Time, arg.WasEndsAt.Valid = m.EndsAt, true
			}
			return q.QueueMeetingMail(r.Context(), arg)
		}
		kept := map[openapi_types.UUID]bool{}
		for _, i := range before {
			to = append(to, uuid(i.UserID).String())
			if i.UserID == m.OrganizerID || slices.Contains(people, uuid(i.UserID)) {
				kept[uuid(i.UserID)] = true
				if changed && i.UserID != actor {
					if err := mail(i, "update"); err != nil {
						return err
					}
				}
				continue
			}
			if _, err := q.RemoveMeetingInvitee(r.Context(), store.RemoveMeetingInviteeParams{MeetingID: m.ID, UserID: i.UserID}); err != nil {
				return err
			}
			if err := mail(i, "cancel"); err != nil {
				return err
			}
		}
		for _, id := range people {
			if kept[id] {
				continue
			}
			to = append(to, id.String())
			if _, err := q.AddMeetingInvitee(r.Context(), store.AddMeetingInviteeParams{MeetingID: m.ID, UserID: pgUUID(id), Response: "pending"}); err != nil {
				return err
			}
			if err := q.QueueMeetingMail(r.Context(), store.QueueMeetingMailParams{MeetingID: m.ID, UserID: pgUUID(id), Kind: "invite"}); err != nil {
				return err
			}
		}
		if !slices.Contains(to, uuid(actor).String()) {
			to = append(to, uuid(actor).String())
		}
		return emit(r.Context(), q, events.MeetingChanged, MeetingEvent{To: to, MeetingID: uuid(m.ID).String()})
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "meeting_cancelled", Detail: "The meeting is cancelled."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update meeting", err)
		return
	}
	h.writeMeeting(w, r, http.StatusOK, updated, p.User)
}

// CancelMeeting implements api.ServerInterface.
func (h *Handlers) CancelMeeting(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	m, ok := h.editableMeeting(w, r, id, p.User)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if _, err := q.CancelMeeting(r.Context(), m.ID); err != nil {
			return err
		}
		return h.tellInvitees(r.Context(), q, m, p.User, "cancel", nil)
	})
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "cancel meeting", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// tellInvitees queues an e-mail to every invitee but the one acting, and
// tells everyone's apps.
func (h *Handlers) tellInvitees(ctx context.Context, q *store.Queries, m store.Meeting, actor store.User, kind string, skipped *time.Time) error {
	rows, err := q.ListMeetingInvitees(ctx, m.ID)
	if err != nil {
		return err
	}
	to := []string{uuid(actor.ID).String()}
	for _, i := range rows {
		if i.UserID == actor.ID {
			continue
		}
		to = append(to, uuid(i.UserID).String())
		arg := store.QueueMeetingMailParams{MeetingID: m.ID, UserID: i.UserID, Kind: kind}
		if skipped != nil {
			arg.WasStartsAt.Time, arg.WasStartsAt.Valid = *skipped, true
		}
		if err := q.QueueMeetingMail(ctx, arg); err != nil {
			return err
		}
	}
	return emit(ctx, q, events.MeetingChanged, MeetingEvent{To: to, MeetingID: uuid(m.ID).String()})
}

// SkipMeetingOccurrence implements api.ServerInterface.
func (h *Handlers) SkipMeetingOccurrence(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	m, ok := h.editableMeeting(w, r, id, p.User)
	if !ok {
		return
	}
	var in struct {
		Occurrence time.Time `json:"occurrence"`
	}
	if !decode(w, r, &in) {
		return
	}
	rule, err := meetings.ParseRule(m.Rrule)
	if err != nil || rule.Freq == "" {
		badRequest(w, r, "Only a repeating meeting has occurrences to cancel; cancel the meeting instead.")
		return
	}
	found := false
	meetings.Occurrences(m.StartsAt, meetings.Location(m.Timezone), rule, m.Exdates, func(t time.Time) bool {
		found = t.Equal(in.Occurrence)
		return !found && !t.After(in.Occurrence)
	})
	if !found {
		badRequest(w, r, "The meeting has no occurrence starting then.")
		return
	}
	var updated store.Meeting
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if updated, err = q.SkipMeetingOccurrence(r.Context(), store.SkipMeetingOccurrenceParams{ID: m.ID, Occurrence: in.Occurrence}); err != nil {
			return err
		}
		occ := in.Occurrence
		return h.tellInvitees(r.Context(), q, m, p.User, "update", &occ)
	})
	if err != nil {
		h.unavailable(w, r, "skip occurrence", err)
		return
	}
	h.writeMeeting(w, r, http.StatusOK, updated, p.User)
}

// AnswerMeeting implements api.ServerInterface.
func (h *Handlers) AnswerMeeting(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	m, _, ok := h.meetingFor(w, r, id, p.User)
	if !ok {
		return
	}
	var in struct {
		Response string `json:"response"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Response != "yes" && in.Response != "maybe" && in.Response != "no" {
		badRequest(w, r, "Answer yes, maybe or no.")
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if _, err := q.SetMeetingResponse(r.Context(), store.SetMeetingResponseParams{MeetingID: m.ID, UserID: p.User.ID, Response: in.Response}); err != nil {
			return err
		}
		rows, err := q.ListMeetingInvitees(r.Context(), m.ID)
		if err != nil {
			return err
		}
		to := make([]string, 0, len(rows))
		for _, i := range rows {
			to = append(to, uuid(i.UserID).String())
		}
		return emit(r.Context(), q, events.MeetingChanged, MeetingEvent{To: to, MeetingID: uuid(m.ID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "answer meeting", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetCalendar implements api.ServerInterface.
func (h *Handlers) GetCalendar(w http.ResponseWriter, r *http.Request, params api.GetCalendarParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if !params.To.After(params.From) || params.To.Sub(params.From) > maxCalendarRange {
		badRequest(w, r, "Ask for a range of up to 62 days.")
		return
	}
	items, err := h.calendarItems(r.Context(), p.User, params.From, params.To)
	if err != nil {
		h.unavailable(w, r, "calendar", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

type calendarMeeting struct {
	item    api.CalendarItem
	meeting store.Meeting
}

// meetingItems lists the occurrences of a person's meetings in a range.
func (h *Handlers) meetingItems(ctx context.Context, user store.User, from, to time.Time, withCancelled bool) ([]calendarMeeting, error) {
	rows, err := h.Queries.MeetingsForUser(ctx, store.MeetingsForUserParams{UserID: user.ID, Since: from, Until: to, WithCancelled: withCancelled})
	if err != nil {
		return nil, err
	}
	var out []calendarMeeting
	for _, row := range rows {
		m := store.Meeting{ID: row.ID, WorkspaceID: row.WorkspaceID, ChannelID: row.ChannelID, OrganizerID: row.OrganizerID,
			Title: row.Title, Agenda: row.Agenda, StartsAt: row.StartsAt, EndsAt: row.EndsAt, Timezone: row.Timezone,
			Rrule: row.Rrule, Exdates: row.Exdates, LastStart: row.LastStart, Sequence: row.Sequence, CancelledAt: row.CancelledAt}
		rule, err := meetings.ParseRule(m.Rrule)
		if err != nil {
			continue
		}
		length := m.EndsAt.Sub(m.StartsAt)
		channel := uuid(m.ChannelID)
		meetings.Occurrences(m.StartsAt, meetings.Location(m.Timezone), rule, m.Exdates, func(t time.Time) bool {
			if !t.Before(to) {
				return false
			}
			if t.Add(length).After(from) {
				out = append(out, calendarMeeting{meeting: m, item: api.CalendarItem{
					Kind: api.CalendarItemKindMeeting, Id: uuid(m.ID), WorkspaceId: uuid(m.WorkspaceID), ChannelId: &channel,
					Title: m.Title, StartsAt: t, EndsAt: t.Add(length), Response: row.Response, Recurring: rule.Freq != "",
				}})
			}
			return true
		})
	}
	return out, nil
}

func (h *Handlers) calendarItems(ctx context.Context, user store.User, from, to time.Time) ([]api.CalendarItem, error) {
	found, err := h.meetingItems(ctx, user, from, to, false)
	if err != nil {
		return nil, err
	}
	items := make([]api.CalendarItem, 0, len(found))
	for _, f := range found {
		items = append(items, f.item)
	}
	evs, err := h.Queries.EventsForUser(ctx, store.EventsForUserParams{UserID: user.ID, Since: from, Until: to})
	if err != nil {
		return nil, err
	}
	for _, e := range evs {
		item := api.CalendarItem{Kind: api.CalendarItemKindEvent, Id: uuid(e.ID), WorkspaceId: uuid(e.WorkspaceID),
			Title: e.Title, StartsAt: e.StartsAt, EndsAt: e.EndsAt, Response: e.Status}
		if e.ChannelID.Valid {
			c := uuid(e.ChannelID)
			item.ChannelId = &c
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].StartsAt.Before(items[j].StartsAt) })
	return items, nil
}

// meetingPlace names where a meeting's call happens.
func meetingPlace(kind, name, title string) string {
	switch kind {
	case "dm":
		return "Cenacle call (direct conversation)"
	case "group":
		if title != "" {
			return "Cenacle call (" + title + ")"
		}
		return "Cenacle call (group conversation)"
	}
	return "Cenacle call in " + name
}

func (h *Handlers) meetingEvent(m store.Meeting, place string, withAgenda bool) meetings.Event {
	base := strings.TrimSuffix(h.PublicURL, "/")
	ev := meetings.Event{
		UID: uuid(m.ID).String() + "@" + hostname(h.PublicURL), Title: m.Title, Location: place,
		URL: base + "/meetings/" + uuid(m.ID).String(), Start: m.StartsAt, End: m.EndsAt, TimeZone: m.Timezone,
		Rule: m.Rrule, Exdates: m.Exdates, Sequence: int(m.Sequence), Cancelled: m.CancelledAt.Valid,
	}
	if withAgenda {
		ev.Description = m.Agenda
	}
	return ev
}

func hostname(public string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(public, "https://"), "http://")
	if i := strings.IndexAny(s, "/:"); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return "cenacle"
	}
	return s
}

// DownloadMeeting implements api.ServerInterface.
func (h *Handlers) DownloadMeeting(w http.ResponseWriter, r *http.Request, id openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	m, _, ok := h.meetingFor(w, r, id, p.User)
	if !ok {
		return
	}
	c, err := h.Queries.GetChannel(r.Context(), m.ChannelID)
	if err != nil {
		h.unavailable(w, r, "meeting channel", err)
		return
	}
	body := meetings.Calendar("PUBLISH", []meetings.Event{h.meetingEvent(m, meetingPlace(c.Kind, c.Name, c.Title), true)}, time.Now())
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="meeting.ics"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body) //nolint:gosec // an attachment of type text/calendar (nosniff), not a page
}

func feedHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// GetCalendarFeed implements api.ServerInterface.
func (h *Handlers) GetCalendarFeed(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	created, err := h.Queries.GetCalendarFeed(r.Context(), p.User.ID)
	if isNoRows(err) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"exists": false, "created_at": nil})
		return
	}
	if err != nil {
		h.unavailable(w, r, "calendar feed", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"exists": true, "created_at": created})
}

// CreateCalendarFeed implements api.ServerInterface.
func (h *Handlers) CreateCalendarFeed(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if p.Bot != nil {
		forbidden(w, r, httpx.CodeForbidden, "Bots have no calendar.")
		return
	}
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token := base64.RawURLEncoding.EncodeToString(raw)
	if err := h.Queries.SetCalendarFeed(r.Context(), store.SetCalendarFeedParams{UserID: p.User.ID, TokenHash: feedHash(token)}); err != nil {
		h.unavailable(w, r, "calendar feed", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]string{"url": strings.TrimSuffix(h.PublicURL, "/") + "/api/calendar-feeds/" + token})
}

// DeleteCalendarFeed implements api.ServerInterface.
func (h *Handlers) DeleteCalendarFeed(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, err := h.Queries.DeleteCalendarFeed(r.Context(), p.User.ID); err != nil {
		h.unavailable(w, r, "calendar feed", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ReadCalendarFeed implements api.ServerInterface: the address is the key.
func (h *Handlers) ReadCalendarFeed(w http.ResponseWriter, r *http.Request, token string) {
	notFound := func() {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "Unknown calendar address."})
	}
	if len(token) < 40 || len(token) > 100 {
		notFound()
		return
	}
	user, err := h.Queries.UserByCalendarFeed(r.Context(), feedHash(token))
	if isNoRows(err) || (err == nil && user.DeactivatedAt.Valid) {
		notFound()
		return
	}
	if err != nil {
		h.unavailable(w, r, "calendar feed", err)
		return
	}
	now := time.Now()
	from, to := now.Add(-feedPast), now.Add(feedFuture)
	rows, err := h.Queries.MeetingsForUser(r.Context(), store.MeetingsForUserParams{UserID: user.ID, Since: from, Until: to, WithCancelled: false})
	if err != nil {
		h.unavailable(w, r, "calendar feed", err)
		return
	}
	evs := make([]meetings.Event, 0, len(rows))
	for _, row := range rows {
		if row.Response == "no" {
			continue
		}
		m := store.Meeting{ID: row.ID, Title: row.Title, StartsAt: row.StartsAt, EndsAt: row.EndsAt, Timezone: row.Timezone,
			Rrule: row.Rrule, Exdates: row.Exdates, Sequence: row.Sequence}
		// Titles, times and places only: the address may end up in other hands.
		evs = append(evs, h.meetingEvent(m, meetingPlace(row.ChannelKind, row.ChannelName, row.ChannelTitle), false))
	}
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=300")
	_, _ = w.Write(meetings.Calendar("", evs, now))
}

// SetLanguage implements api.ServerInterface.
func (h *Handlers) SetLanguage(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in struct {
		Language *string `json:"language"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Language != nil && *in.Language != "en" && *in.Language != "tr" {
		badRequest(w, r, "The language is en or tr.")
		return
	}
	var lang pgtype.Text
	if in.Language != nil {
		lang = pgtype.Text{String: *in.Language, Valid: true}
	}
	if err := h.Queries.SetUserLanguage(r.Context(), store.SetUserLanguageParams{ID: p.User.ID, Language: lang}); err != nil {
		h.unavailable(w, r, "set language", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SendTestEmail implements api.ServerInterface.
func (h *Handlers) SendTestEmail(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	if h.MeetingMail == nil || !h.EmailAvailable {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "email_unavailable", Detail: "E-mail is not set up on this server."})
		return
	}
	if !p.User.EmailVerified || p.User.Email == "" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "no_email", Detail: "Your account has no verified e-mail address."})
		return
	}
	if err := h.MeetingMail.SendSample(r.Context(), p.User.Email, p.User.DisplayName, p.User.Language.String, p.User.Timezone); err != nil {
		h.Log.WarnContext(r.Context(), "test e-mail", "error", err)
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadGateway, Code: "email_failed",
			Detail: "The mail server did not take the e-mail: " + err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
