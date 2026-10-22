// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Codes of community features.
const (
	CodePollClosed    = "poll_closed"
	CodeTermsRequired = "terms_required"
	CodeTermsChanged  = "terms_changed"
	// EventReminderBefore is how long before an event "going" people are reminded.
	EventReminderBefore = 15 * time.Minute
)

// ---------------------------------------------------------- message extras ---

// postExtras are the parts of a message beyond its text: a forum post's
// title and tags, a poll.
type postExtras struct {
	title pgtype.Text
	tags  []string
	poll  *api.NewPoll
	// link is the first web address of the text (its preview follows).
	link    pgtype.Text
	forward []byte
	sticker pgtype.UUID
	burn    pgtype.Int4
	// presence tells who @here reaches.
	presence PresenceReader
}

func (e postExtras) titleText() string { return e.title.String }

// messageExtras checks a new message's title, tags and poll for its channel.
func (h *Handlers) messageExtras(c store.Channel, in api.NewMessage) (postExtras, string) {
	var out postExtras
	post := c.Kind == KindForum && in.RootId == nil
	if in.Title != nil {
		title := strings.TrimSpace(*in.Title)
		if !post {
			return out, "Only posts in forums have titles."
		}
		if title == "" || utf8.RuneCountInString(title) > 200 {
			return out, "A title has 1 to 200 characters."
		}
		out.title = pgtype.Text{String: title, Valid: true}
	} else if post {
		return out, "A forum post needs a title."
	}
	if in.Tags != nil {
		if !post {
			return out, "Only posts in forums have tags."
		}
		tags, problem := cleanTags(*in.Tags, MaxMessageTags)
		if problem != "" {
			return out, problem
		}
		for _, t := range tags {
			if !slices.ContainsFunc(c.ForumTags, func(f string) bool { return strings.EqualFold(f, t) }) {
				return out, "“" + t + "” is not one of this forum's tags."
			}
		}
		out.tags = tags
	}
	if in.Poll != nil {
		p := in.Poll
		if len(p.Options) < 2 || len(p.Options) > 10 {
			return out, "A poll has 2 to 10 options."
		}
		for i, o := range p.Options {
			o = strings.TrimSpace(o)
			if o == "" || utf8.RuneCountInString(o) > 200 {
				return out, "An option has 1 to 200 characters."
			}
			p.Options[i] = o
		}
		if p.ClosesAt != nil && (!p.ClosesAt.After(time.Now()) || time.Until(*p.ClosesAt) > MaxReminderAhead) {
			return out, "A poll closes within the coming year."
		}
		if strings.TrimSpace(in.Body) == "" {
			return out, "A poll needs a question (the message text)."
		}
		out.poll = p
	}
	return out, ""
}

// ------------------------------------------------------------------ polls ---

func createPoll(ctx context.Context, q *store.Queries, message pgtype.UUID, p *api.NewPoll) error {
	if p == nil {
		return nil
	}
	var closes pgtype.Timestamptz
	if p.ClosesAt != nil {
		closes = pgtype.Timestamptz{Time: *p.ClosesAt, Valid: true}
	}
	if err := q.CreatePoll(ctx, store.CreatePollParams{
		MessageID: message, Multiple: p.Multiple != nil && *p.Multiple,
		Anonymous: p.Anonymous != nil && *p.Anonymous, ClosesAt: closes,
	}); err != nil {
		return err
	}
	return q.AddPollOptions(ctx, store.AddPollOptionsParams{MessageID: message, Texts: p.Options})
}

// pollsFor returns the polls of messages as a reader sees them.
func pollsFor(ctx context.Context, q store.Querier, reader pgtype.UUID, ids []pgtype.UUID) (map[pgtype.UUID]*api.Poll, error) {
	polls, err := q.ListPolls(ctx, ids)
	if err != nil || len(polls) == 0 {
		return nil, err
	}
	pollIDs := make([]pgtype.UUID, len(polls))
	out := make(map[pgtype.UUID]*api.Poll, len(polls))
	for i, p := range polls {
		pollIDs[i] = p.MessageID
		closed := p.ClosedAt.Valid || (p.ClosesAt.Valid && p.ClosesAt.Time.Before(time.Now()))
		out[p.MessageID] = &api.Poll{Multiple: p.Multiple, Anonymous: p.Anonymous, ClosesAt: timePtr(p.ClosesAt),
			Closed: closed, Options: []api.PollOption{}}
	}
	options, err := q.ListPollOptions(ctx, store.ListPollOptionsParams{ReaderID: reader, MessageIds: pollIDs})
	if err != nil {
		return nil, err
	}
	voters, err := q.ListPollVoters(ctx, pollIDs)
	if err != nil {
		return nil, err
	}
	byOption := map[pgtype.UUID][]api.Author{}
	for _, v := range voters {
		a := api.Author{Id: uuid(v.UserID), DisplayName: v.DisplayName}
		if v.IsBot {
			a.IsBot = ptr(true)
		}
		byOption[v.OptionID] = append(byOption[v.OptionID], a)
	}
	for _, o := range options {
		p := out[o.MessageID]
		entry := api.PollOption{Id: uuid(o.ID), Me: o.Me, Text: o.Text, Votes: int(o.Votes)}
		if !p.Anonymous {
			list := append([]api.Author{}, byOption[o.ID]...)
			entry.Voters = &list
		}
		p.Options = append(p.Options, entry)
	}
	counts, err := q.CountPollVoters(ctx, pollIDs)
	if err != nil {
		return nil, err
	}
	for _, c := range counts {
		out[c.MessageID].Voters = int(c.Voters)
	}
	return out, nil
}

// PollEvent is the data of poll.updated; `poll` is as the voter (user_id) sees it.
type PollEvent struct {
	ChannelID string   `json:"channel_id"`
	MessageID string   `json:"message_id"`
	UserID    string   `json:"user_id"`
	Poll      api.Poll `json:"poll"`
}

// pollMessage loads a message with a poll for a member of its channel.
func (h *Handlers) pollMessage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID, user store.User) (store.Channel, access, store.GetMessageRow, store.Poll, bool) {
	c, role, m, ok := h.message(w, r, channelID, messageID, user)
	if !ok {
		return c, role, m, store.Poll{}, false
	}
	poll, err := h.Queries.GetPoll(r.Context(), m.ID)
	if isNoRows(err) || m.DeletedAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "This message has no poll."})
		return c, role, m, poll, false
	}
	if err != nil {
		h.unavailable(w, r, "get poll", err)
		return c, role, m, poll, false
	}
	return c, role, m, poll, true
}

// pollChanged answers with the poll as the user sees it and tells the channel.
func (h *Handlers) pollChanged(w http.ResponseWriter, r *http.Request, c store.Channel, m store.GetMessageRow, user store.User) {
	polls, err := pollsFor(r.Context(), h.Queries, user.ID, []pgtype.UUID{m.ID})
	if err != nil || polls[m.ID] == nil {
		h.unavailable(w, r, "load poll", err)
		return
	}
	poll := *polls[m.ID]
	h.publish(r.Context(), events.PollUpdated, PollEvent{
		ChannelID: uuid(c.ID).String(), MessageID: uuid(m.ID).String(), UserID: uuid(user.ID).String(), Poll: poll,
	})
	httpx.WriteJSON(w, http.StatusOK, poll)
}

// VotePoll implements api.ServerInterface.
func (h *Handlers) VotePoll(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.VotePollJSONBody
	if !decode(w, r, &in) {
		return
	}
	c, _, m, poll, ok := h.pollMessage(w, r, channelID, messageID, p.User)
	if !ok || h.timedOut(w, r, c.WorkspaceID, p.User) {
		return
	}
	if poll.ClosedAt.Valid || (poll.ClosesAt.Valid && poll.ClosesAt.Time.Before(time.Now())) || c.ArchivedAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodePollClosed, Detail: "The poll is closed."})
		return
	}
	ids := make([]pgtype.UUID, 0, len(in.OptionIds))
	for _, id := range in.OptionIds {
		if !slices.Contains(ids, pgUUID(id)) {
			ids = append(ids, pgUUID(id))
		}
	}
	if len(ids) > 1 && !poll.Multiple {
		badRequest(w, r, "Choose one option in this poll.")
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.ClearPollVotes(r.Context(), store.ClearPollVotesParams{MessageID: m.ID, UserID: p.User.ID}); err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		n, err := q.AddPollVotes(r.Context(), store.AddPollVotesParams{UserID: p.User.ID, MessageID: m.ID, OptionIds: ids})
		if err != nil {
			return err
		}
		if n != int64(len(ids)) {
			return errBadOption
		}
		return nil
	})
	if errors.Is(err, errBadOption) {
		badRequest(w, r, "An option is not one of this poll's.")
		return
	}
	if err != nil {
		h.unavailable(w, r, "vote", err)
		return
	}
	h.pollChanged(w, r, c, m, p.User)
}

var errBadOption = errors.New("not an option of the poll")

// ClosePoll implements api.ServerInterface.
func (h *Handlers) ClosePoll(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, m, _, ok := h.pollMessage(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.AuthorID != p.User.ID && !canManage(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the poll's author or a channel manager closes it.")
		return
	}
	if err := h.Queries.ClosePoll(r.Context(), m.ID); err != nil {
		h.unavailable(w, r, "close poll", err)
		return
	}
	h.pollChanged(w, r, c, m, p.User)
}

// ----------------------------------------------------------------- events ---

func (h *Handlers) eventsAPI(ctx context.Context, list []store.Event, user store.User, role string) ([]api.Event, error) {
	ids := make([]pgtype.UUID, len(list))
	for i, e := range list {
		ids[i] = e.ID
	}
	rsvps, err := h.Queries.ListEventRsvps(ctx, ids)
	if err != nil {
		return nil, err
	}
	creators := []pgtype.UUID{}
	for _, e := range list {
		if e.CreatedBy.Valid {
			creators = append(creators, e.CreatedBy)
		}
	}
	people, err := h.Queries.GetUsersByIDs(ctx, creators)
	if err != nil {
		return nil, err
	}
	names := map[pgtype.UUID]string{}
	for _, u := range people {
		names[u.ID] = u.DisplayName
	}
	out := make([]api.Event, len(list))
	for i, e := range list {
		ev := api.Event{
			Id: uuid(e.ID), WorkspaceId: uuid(e.WorkspaceID), Title: e.Title, Description: e.Description,
			Location: e.Location, StartsAt: e.StartsAt, EndsAt: e.EndsAt, Canceled: e.CanceledAt.Valid,
			Going: []api.Author{}, CanEdit: e.CreatedBy == user.ID || isWorkspaceAdmin(role),
		}
		if e.ChannelID.Valid {
			ev.ChannelId = ptr(uuid(e.ChannelID))
		}
		if e.CreatedBy.Valid {
			ev.CreatedBy = &api.Author{Id: uuid(e.CreatedBy), DisplayName: names[e.CreatedBy]}
		}
		for _, r := range rsvps {
			if r.EventID != e.ID {
				continue
			}
			switch r.Status {
			case "going":
				ev.Going = append(ev.Going, api.Author{Id: uuid(r.UserID), DisplayName: r.DisplayName})
			case "maybe":
				ev.Maybe++
			}
			if r.UserID == user.ID {
				ev.Me = ptr(api.EventMe(r.Status))
			}
		}
		out[i] = ev
	}
	return out, nil
}

// eventInput checks an event as sent; the channel must be one of the
// workspace's channels the user can post in.
func (h *Handlers) eventInput(w http.ResponseWriter, r *http.Request, workspace pgtype.UUID, in api.EventInput, user store.User) (store.CreateEventParams, bool) {
	out := store.CreateEventParams{WorkspaceID: workspace, Title: strings.TrimSpace(in.Title),
		StartsAt: in.StartsAt, EndsAt: in.EndsAt, CreatedBy: user.ID}
	if in.Description != nil {
		out.Description = strings.TrimSpace(*in.Description)
	}
	if in.Location != nil {
		out.Location = strings.TrimSpace(*in.Location)
	}
	problem := ""
	switch {
	case out.Title == "" || utf8.RuneCountInString(out.Title) > 200:
		problem = "A title has 1 to 200 characters."
	case utf8.RuneCountInString(out.Description) > 4000:
		problem = "The description is longer than 4000 characters."
	case utf8.RuneCountInString(out.Location) > 300:
		problem = "The location is longer than 300 characters."
	case !in.EndsAt.After(in.StartsAt):
		problem = "An event ends after it starts."
	case in.EndsAt.Sub(in.StartsAt) > 14*24*time.Hour:
		problem = "An event lasts at most 14 days."
	}
	if problem != "" {
		badRequest(w, r, problem)
		return out, false
	}
	if in.ChannelId != nil {
		c, role, ok := h.memberChannel(w, r, *in.ChannelId, user)
		if !ok {
			return out, false
		}
		if c.WorkspaceID != workspace || !canPost(c, role) {
			forbidden(w, r, httpx.CodeForbidden, "You cannot post in that channel.")
			return out, false
		}
		out.ChannelID = c.ID
	}
	return out, true
}

// ListEvents implements api.ServerInterface.
func (h *Handlers) ListEvents(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.ListEventsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	after := time.Now()
	if params.From != nil {
		after = *params.From
	}
	list, err := h.Queries.ListEvents(r.Context(), store.ListEventsParams{WorkspaceID: pgUUID(workspaceID), After: after})
	if err != nil {
		h.unavailable(w, r, "list events", err)
		return
	}
	out, err := h.eventsAPI(r.Context(), list, p.User, role)
	if err != nil {
		h.unavailable(w, r, "load events", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Event{"events": out})
}

func (h *Handlers) writeEvent(w http.ResponseWriter, r *http.Request, status int, e store.Event, user store.User, role string) {
	out, err := h.eventsAPI(r.Context(), []store.Event{e}, user, role)
	if err != nil {
		h.unavailable(w, r, "load event", err)
		return
	}
	httpx.WriteJSON(w, status, out[0])
}

// CreateEvent implements api.ServerInterface.
func (h *Handlers) CreateEvent(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.EventInput
	if !decode(w, r, &in) {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if role == WorkspaceGuest {
		forbidden(w, r, httpx.CodeForbidden, "Guests do not plan events.")
		return
	}
	arg, ok := h.eventInput(w, r, pgUUID(workspaceID), in, p.User)
	if !ok {
		return
	}
	if !in.StartsAt.After(time.Now()) {
		badRequest(w, r, "An event starts in the future.")
		return
	}
	var e store.Event
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if e, err = q.CreateEvent(r.Context(), arg); err != nil {
			return err
		}
		if e.ChannelID.Valid {
			c, err := q.GetChannel(r.Context(), e.ChannelID)
			if err != nil {
				return err
			}
			body := "📅 **" + e.Title + "**"
			if e.Description != "" {
				body += "\n\n" + e.Description
			}
			if _, err := postMessage(r.Context(), q, c, p.User, body, "event-"+uuid(e.ID).String(), []byte("[]")); err != nil {
				return err
			}
		}
		return emit(r.Context(), q, events.EventChanged, WorkspaceEvent{WorkspaceID: workspaceID.String()})
	})
	if err != nil {
		h.unavailable(w, r, "create event", err)
		return
	}
	h.writeEvent(w, r, http.StatusCreated, e, p.User, role)
}

// editableEvent loads an event the user may change (its creator or a workspace admin).
func (h *Handlers) editableEvent(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Event, string, bool) {
	e, err := h.Queries.GetEvent(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such event."})
		return e, "", false
	}
	if err != nil {
		h.unavailable(w, r, "get event", err)
		return e, "", false
	}
	role, ok := h.workspaceRole(w, r, uuid(e.WorkspaceID), user)
	if !ok {
		return e, role, false
	}
	return e, role, true
}

// UpdateEvent implements api.ServerInterface.
func (h *Handlers) UpdateEvent(w http.ResponseWriter, r *http.Request, eventID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.EventInput
	if !decode(w, r, &in) {
		return
	}
	e, role, ok := h.editableEvent(w, r, eventID, p.User)
	if !ok {
		return
	}
	if e.CreatedBy != p.User.ID && !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the event's creator or a workspace admin changes it.")
		return
	}
	arg, ok := h.eventInput(w, r, e.WorkspaceID, in, p.User)
	if !ok {
		return
	}
	var updated store.Event
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		updated, err = q.UpdateEvent(r.Context(), store.UpdateEventParams{
			ID: e.ID, ChannelID: arg.ChannelID, Title: arg.Title, Description: arg.Description,
			Location: arg.Location, StartsAt: arg.StartsAt, EndsAt: arg.EndsAt,
		})
		if err != nil {
			return err
		}
		// A new start moves the reminders of those going.
		if !updated.StartsAt.Equal(e.StartsAt) {
			if err := h.moveEventReminders(r.Context(), q, updated); err != nil {
				return err
			}
		}
		return emit(r.Context(), q, events.EventChanged, WorkspaceEvent{WorkspaceID: uuid(e.WorkspaceID).String()})
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The event was canceled."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update event", err)
		return
	}
	h.writeEvent(w, r, http.StatusOK, updated, p.User, role)
}

func (h *Handlers) moveEventReminders(ctx context.Context, q *store.Queries, e store.Event) error {
	reminders, err := q.ListEventReminders(ctx, e.ID)
	if err != nil {
		return err
	}
	for _, rem := range reminders {
		if err := q.CancelScheduled(ctx, rem.ReminderID); err != nil {
			return err
		}
		user, err := q.GetUser(ctx, rem.UserID)
		if err != nil {
			return err
		}
		reminder, err := h.eventReminder(ctx, q, e, user)
		if err != nil {
			return err
		}
		if err := q.SetRsvp(ctx, store.SetRsvpParams{EventID: e.ID, UserID: rem.UserID, Status: "going", ReminderID: reminder}); err != nil {
			return err
		}
	}
	return nil
}

// eventReminder schedules the reminder of someone going (none when too late).
func (h *Handlers) eventReminder(ctx context.Context, q *store.Queries, e store.Event, user store.User) (pgtype.UUID, error) {
	at := e.StartsAt.Add(-EventReminderBefore)
	if !at.After(time.Now()) {
		return pgtype.UUID{}, nil
	}
	s, err := h.scheduleReminder(ctx, q, e.WorkspaceID, user, "📅 "+e.Title+" starts in 15 minutes.", at)
	return s.ID, err
}

// CancelEvent implements api.ServerInterface.
func (h *Handlers) CancelEvent(w http.ResponseWriter, r *http.Request, eventID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	e, role, ok := h.editableEvent(w, r, eventID, p.User)
	if !ok {
		return
	}
	if e.CreatedBy != p.User.ID && !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the event's creator or a workspace admin cancels it.")
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if _, err := q.CancelEvent(r.Context(), e.ID); err != nil {
			return err
		}
		reminders, err := q.ListEventReminders(r.Context(), e.ID)
		if err != nil {
			return err
		}
		for _, rem := range reminders {
			if err := q.CancelScheduled(r.Context(), rem.ReminderID); err != nil {
				return err
			}
		}
		return emit(r.Context(), q, events.EventChanged, WorkspaceEvent{WorkspaceID: uuid(e.WorkspaceID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "cancel event", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RsvpEvent implements api.ServerInterface.
func (h *Handlers) RsvpEvent(w http.ResponseWriter, r *http.Request, eventID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.RsvpEventJSONBody
	if !decode(w, r, &in) {
		return
	}
	e, role, ok := h.editableEvent(w, r, eventID, p.User)
	if !ok {
		return
	}
	if e.CanceledAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The event was canceled."})
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		old, err := q.GetRsvp(r.Context(), store.GetRsvpParams{EventID: e.ID, UserID: p.User.ID})
		if err != nil && !isNoRows(err) {
			return err
		}
		if old.ReminderID.Valid {
			if err := q.CancelScheduled(r.Context(), old.ReminderID); err != nil {
				return err
			}
		}
		if in.Status == nil {
			if err := q.DeleteRsvp(r.Context(), store.DeleteRsvpParams{EventID: e.ID, UserID: p.User.ID}); err != nil {
				return err
			}
		} else {
			var reminder pgtype.UUID
			if *in.Status == api.RsvpEventJSONBodyStatusGoing {
				if reminder, err = h.eventReminder(r.Context(), q, e, p.User); err != nil {
					return err
				}
			}
			if err := q.SetRsvp(r.Context(), store.SetRsvpParams{
				EventID: e.ID, UserID: p.User.ID, Status: string(*in.Status), ReminderID: reminder,
			}); err != nil {
				return err
			}
		}
		return emit(r.Context(), q, events.EventChanged, WorkspaceEvent{WorkspaceID: uuid(e.WorkspaceID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "answer event", err)
		return
	}
	h.writeEvent(w, r, http.StatusOK, e, p.User, role)
}

// --------------------------------------------------------------- welcome ---

type welcome struct {
	Message    string   `json:"message"`
	Rules      []string `json:"rules"`
	ChannelIDs []string `json:"channel_ids"`
}

func (w welcome) set() bool { return strings.TrimSpace(w.Message) != "" || len(w.Rules) > 0 }

func welcomeOf(ws store.Workspace) welcome {
	var out welcome
	_ = json.Unmarshal(ws.Welcome, &out)
	if out.Rules == nil {
		out.Rules = []string{}
	}
	if out.ChannelIDs == nil {
		out.ChannelIDs = []string{}
	}
	return out
}

func welcomeAPI(in welcome) api.Welcome {
	out := api.Welcome{Message: in.Message, Rules: in.Rules, ChannelIds: []openapi_types.UUID{}}
	for _, id := range in.ChannelIDs {
		var u openapi_types.UUID
		if err := u.UnmarshalText([]byte(id)); err == nil {
			out.ChannelIds = append(out.ChannelIds, u)
		}
	}
	return out
}

// GetWelcome implements api.ServerInterface.
func (h *Handlers) GetWelcome(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, welcomeAPI(welcomeOf(ws)))
}

// SetWelcome implements api.ServerInterface.
func (h *Handlers) SetWelcome(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.Welcome
	if !decode(w, r, &in) {
		return
	}
	if !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins set its welcome.") {
		return
	}
	out := welcome{Message: strings.TrimSpace(in.Message), Rules: []string{}, ChannelIDs: []string{}}
	if utf8.RuneCountInString(out.Message) > 4000 {
		badRequest(w, r, "The message is longer than 4000 characters.")
		return
	}
	for _, rule := range in.Rules {
		if rule = strings.TrimSpace(rule); rule != "" {
			if utf8.RuneCountInString(rule) > 500 {
				badRequest(w, r, "A rule is longer than 500 characters.")
				return
			}
			out.Rules = append(out.Rules, rule)
		}
	}
	if len(out.Rules) > 20 || len(in.ChannelIds) > 20 {
		badRequest(w, r, "At most 20 rules and 20 channels.")
		return
	}
	for _, id := range in.ChannelIds {
		c, err := h.Queries.GetChannel(r.Context(), pgUUID(id))
		if isNoRows(err) || (err == nil && (uuid(c.WorkspaceID) != workspaceID || c.Visibility != Public || isConversation(c) || c.ArchivedAt.Valid)) {
			badRequest(w, r, "Suggested channels are public channels of this workspace.")
			return
		}
		if err != nil {
			h.unavailable(w, r, "get channel", err)
			return
		}
		out.ChannelIDs = append(out.ChannelIDs, id.String())
	}
	raw, _ := json.Marshal(out)
	if _, err := h.Queries.SetWorkspaceWelcome(r.Context(), store.SetWorkspaceWelcomeParams{ID: pgUUID(workspaceID), Welcome: raw}); err != nil {
		h.unavailable(w, r, "set welcome", err)
		return
	}
	h.record(r, pgUUID(workspaceID), audit.WelcomeChanged, "workspace", workspaceID.String(), map[string]any{
		"rules": len(out.Rules), "channels": len(out.ChannelIDs),
	})
	httpx.WriteJSON(w, http.StatusOK, welcomeAPI(out))
}

// FinishOnboarding implements api.ServerInterface.
func (h *Handlers) FinishOnboarding(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.FinishOnboardingJSONBody
	if !decode(w, r, &in) {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return
	}
	suggested := welcomeOf(ws).ChannelIDs
	for _, id := range in.JoinChannelIds {
		if !slices.Contains(suggested, id.String()) || role == WorkspaceGuest {
			continue
		}
		c, err := h.Queries.GetChannel(r.Context(), pgUUID(id))
		if err != nil || c.Visibility != Public || c.ArchivedAt.Valid || c.GroupManaged {
			continue
		}
		n, err := h.Queries.AddMember(r.Context(), store.AddMemberParams{ChannelID: c.ID, UserID: p.User.ID, Role: RoleMember})
		if err != nil {
			h.unavailable(w, r, "join channel", err)
			return
		}
		if n > 0 {
			h.membersChanged(r.Context(), c, p.User.ID, events.ChannelJoined, toAPI(c, access{ch: RoleMember, ws: role}))
		}
	}
	if _, err := h.Queries.SetOnboarded(r.Context(), store.SetOnboardedParams{WorkspaceID: pgUUID(workspaceID), UserID: p.User.ID}); err != nil {
		h.unavailable(w, r, "finish onboarding", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ------------------------------------------------------- banner and terms ---

func requireInstanceAdmin(w http.ResponseWriter, r *http.Request, user store.User) bool {
	if !user.IsAdmin {
		forbidden(w, r, httpx.CodeForbidden, "Only instance administrators do this.")
		return false
	}
	return true
}

func bannerAPI(b store.InstanceBanner) api.Banner {
	return api.Banner{Text: b.Text, Level: api.BannerLevel(b.Level), Dismissible: b.Dismissible, UpdatedAt: b.UpdatedAt}
}

// GetBanner implements api.ServerInterface.
func (h *Handlers) GetBanner(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.RequirePrincipal(w, r, h.Cookies); !ok {
		return
	}
	b, err := h.Queries.GetBanner(r.Context())
	if isNoRows(err) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"banner": nil})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get banner", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"banner": bannerAPI(b)})
}

// SetBanner implements api.ServerInterface.
func (h *Handlers) SetBanner(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.BannerInput
	if !decode(w, r, &in) || !requireInstanceAdmin(w, r, p.User) {
		return
	}
	text := strings.TrimSpace(in.Text)
	if text == "" || utf8.RuneCountInString(text) > 500 {
		badRequest(w, r, "The banner has 1 to 500 characters.")
		return
	}
	switch in.Level {
	case api.BannerInputLevelInfo, api.BannerInputLevelWarning, api.BannerInputLevelCritical:
	default:
		badRequest(w, r, "level must be info, warning or critical.")
		return
	}
	var b store.InstanceBanner
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if b, err = q.SetBanner(r.Context(), store.SetBannerParams{
			Text: text, Level: string(in.Level), Dismissible: in.Dismissible == nil || *in.Dismissible,
		}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.BannerChanged, struct{}{})
	})
	if err != nil {
		h.unavailable(w, r, "set banner", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.BannerChanged, "instance", "banner", map[string]any{"level": b.Level})
	httpx.WriteJSON(w, http.StatusOK, bannerAPI(b))
}

// RemoveBanner implements api.ServerInterface.
func (h *Handlers) RemoveBanner(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p.User) {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.DeleteBanner(r.Context()); err != nil {
			return err
		}
		return emit(r.Context(), q, events.BannerChanged, struct{}{})
	})
	if err != nil {
		h.unavailable(w, r, "remove banner", err)
		return
	}
	h.record(r, pgtype.UUID{}, audit.BannerChanged, "instance", "banner", map[string]any{"level": nil})
	w.WriteHeader(http.StatusNoContent)
}

// termsCache keeps the terms in force for a few seconds: every API request
// asks for them (TermsGate).
type termsCache struct {
	mu      sync.Mutex
	until   time.Time
	id      pgtype.UUID
	present bool
}

const termsCacheTTL = 10 * time.Second

func (h *Handlers) activeTerms(ctx context.Context) (pgtype.UUID, bool, error) {
	h.terms.mu.Lock()
	defer h.terms.mu.Unlock()
	if time.Now().Before(h.terms.until) {
		return h.terms.id, h.terms.present, nil
	}
	t, err := h.Queries.GetActiveTerms(ctx)
	if err != nil && !isNoRows(err) {
		return pgtype.UUID{}, false, err
	}
	h.terms.id, h.terms.present, h.terms.until = t.ID, err == nil, time.Now().Add(termsCacheTTL)
	return h.terms.id, h.terms.present, nil
}

func (h *Handlers) forgetTerms() {
	h.terms.mu.Lock()
	h.terms.until = time.Time{}
	h.terms.mu.Unlock()
}

// TermsGate answers 403 terms_required to people who have not accepted the
// terms of service in force, except for what they need to read and accept
// them (their session, the terms, sign-out, interface texts).
func (h *Handlers) TermsGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := auth.PrincipalFrom(r.Context())
		path := r.URL.Path
		if !ok || p.User.IsBot || !strings.HasPrefix(path, "/api/") || termsExempt(path) {
			next.ServeHTTP(w, r)
			return
		}
		id, present, err := h.activeTerms(r.Context())
		if err != nil {
			h.unavailable(w, r, "get terms", err)
			return
		}
		if present && p.User.TermsAcceptedID != id {
			forbidden(w, r, CodeTermsRequired, "Accept the terms of service to continue.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// termsExempt: what a person needs before accepting the terms.
func termsExempt(path string) bool {
	if strings.HasPrefix(path, "/api/auth/") {
		return true
	}
	for _, p := range []string{"/api/session", "/api/terms", "/api/ui-texts", "/api/me/profile", "/api/me/appearance", "/api/banner"} {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}

func termsAPI(t store.TermsOfService) api.Terms {
	return api.Terms{Id: uuid(t.ID), Text: t.Text, CreatedAt: t.CreatedAt}
}

// GetTerms implements api.ServerInterface.
func (h *Handlers) GetTerms(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	t, err := h.Queries.GetActiveTerms(r.Context())
	if isNoRows(err) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"terms": nil, "accepted": true})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get terms", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"terms": termsAPI(t), "accepted": p.User.TermsAcceptedID == t.ID})
}

// SetTerms implements api.ServerInterface.
func (h *Handlers) SetTerms(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetTermsJSONBody
	if !decode(w, r, &in) || !requireInstanceAdmin(w, r, p.User) {
		return
	}
	text := strings.TrimSpace(in.Text)
	if text == "" || utf8.RuneCountInString(text) > 20000 {
		badRequest(w, r, "The terms have 1 to 20000 characters.")
		return
	}
	var t store.TermsOfService
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.WithdrawTerms(r.Context()); err != nil {
			return err
		}
		var err error
		if t, err = q.CreateTerms(r.Context(), store.CreateTermsParams{Text: text, CreatedBy: p.User.ID}); err != nil {
			return err
		}
		// The administrator who wrote them accepts them.
		if err := q.AcceptTerms(r.Context(), store.AcceptTermsParams{TermsID: t.ID, UserID: p.User.ID}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.TermsChanged, struct{}{})
	})
	if err != nil {
		h.unavailable(w, r, "set terms", err)
		return
	}
	h.forgetTerms()
	h.record(r, pgtype.UUID{}, audit.TermsChanged, "instance", uuid(t.ID).String(), map[string]any{"change": "published"})
	httpx.WriteJSON(w, http.StatusOK, termsAPI(t))
}

// WithdrawTerms implements api.ServerInterface.
func (h *Handlers) WithdrawTerms(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p.User) {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.WithdrawTerms(r.Context()); err != nil {
			return err
		}
		return emit(r.Context(), q, events.TermsChanged, struct{}{})
	})
	if err != nil {
		h.unavailable(w, r, "withdraw terms", err)
		return
	}
	h.forgetTerms()
	h.record(r, pgtype.UUID{}, audit.TermsChanged, "instance", "terms", map[string]any{"change": "withdrawn"})
	w.WriteHeader(http.StatusNoContent)
}

// AcceptTerms implements api.ServerInterface.
func (h *Handlers) AcceptTerms(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.AcceptTermsJSONBody
	if !decode(w, r, &in) {
		return
	}
	t, err := h.Queries.GetActiveTerms(r.Context())
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "get terms", err)
		return
	}
	if isNoRows(err) || uuid(t.ID) != in.TermsId {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeTermsChanged,
			Detail: "These are not the terms in force; read them again."})
		return
	}
	if err := h.Queries.AcceptTerms(r.Context(), store.AcceptTermsParams{TermsID: t.ID, UserID: p.User.ID}); err != nil {
		h.unavailable(w, r, "accept terms", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
