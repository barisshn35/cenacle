// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Limits of channel tabs, canvases and lists.
const (
	MaxTabs          = 20
	MaxListItems     = 2000
	MaxListColumns   = 20
	MaxCanvasBody    = 50000
	canvasTurn       = 2 * time.Minute
	CodeTabLimit     = "tab_limit"
	CodeListFull     = "list_full"
	CodeCanvasBusy   = "canvas_busy"
	CodeCanvasChange = "canvas_changed"
)

// The values of a status column.
var statuses = []string{"todo", "doing", "done"}

// TabsEvent tells a channel's members that its tabs changed.
type TabsEvent struct {
	ChannelID string `json:"channel_id"`
}

// CanvasEvent carries a canvas as saved, or who now edits it.
type CanvasEvent struct {
	ChannelID string     `json:"channel_id"`
	Canvas    api.Canvas `json:"canvas"`
}

// ListEvent tells a channel's members that a list or its rows changed.
type ListEvent struct {
	ChannelID string `json:"channel_id"`
	ListID    string `json:"list_id"`
}

func tabAPI(t store.ChannelTab, c store.Channel, a access, user pgtype.UUID) api.Tab {
	out := api.Tab{
		Id: uuid(t.ID), ChannelId: uuid(t.ChannelID), Kind: api.TabKind(t.Kind), Title: t.Title,
		Position:  int(t.Position),
		CanDelete: canPost(c, a) && (t.CreatedBy == user || canManage(c, a)),
	}
	if t.Url.Valid {
		out.Url = &t.Url.String
	}
	if t.CanvasID.Valid {
		id := uuid(t.CanvasID)
		out.CanvasId = &id
	}
	if t.ListID.Valid {
		id := uuid(t.ListID)
		out.ListId = &id
	}
	return out
}

func tabTitle(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, s != "" && utf8.RuneCountInString(s) <= 80
}

func linkURL(s string) (string, bool) {
	s = strings.TrimSpace(s)
	u, err := url.Parse(s)
	return s, err == nil && len(s) <= 2000 && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

// ListChannelTabs implements api.ServerInterface.
func (h *Handlers) ListChannelTabs(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	tabs, err := h.Queries.ListChannelTabs(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list tabs", err)
		return
	}
	out := make([]api.Tab, len(tabs))
	for i, t := range tabs {
		out[i] = tabAPI(t, c, role, p.User.ID)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Tab{"tabs": out})
}

// CreateChannelTab implements api.ServerInterface.
func (h *Handlers) CreateChannelTab(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, role, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !canPost(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "Only people who can post here add tabs.")
		return
	}
	if !serverReadable(w, r, c) {
		return
	}
	var in api.TabInput
	if !decode(w, r, &in) {
		return
	}
	title, ok := tabTitle(in.Title)
	if !ok {
		badRequest(w, r, "A tab's title has 1 to 80 characters.")
		return
	}
	arg := store.CreateChannelTabParams{ChannelID: c.ID, Kind: string(in.Kind), Title: title, CreatedBy: p.User.ID}
	var columns []byte
	var board pgtype.Text
	switch in.Kind {
	case api.TabInputKindLink:
		link, ok := linkURL(deref1(in.Url))
		if !ok {
			badRequest(w, r, "A link tab needs an http(s) address.")
			return
		}
		arg.Url = pgtype.Text{String: link, Valid: true}
	case api.TabInputKindCanvas:
	case api.TabInputKindList:
		cols, b, problem := cleanColumns(deref(in.Columns), in.BoardColumn)
		if problem != "" {
			badRequest(w, r, problem)
			return
		}
		columns, _ = json.Marshal(cols)
		board = textOf(b)
	default:
		badRequest(w, r, "A tab is a canvas, a list or a link.")
		return
	}
	n, err := h.Queries.CountChannelTabs(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "count tabs", err)
		return
	}
	if n >= MaxTabs {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeTabLimit,
			Detail: "A channel has up to 20 tabs; delete one first."})
		return
	}
	var tab store.ChannelTab
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		switch in.Kind {
		case api.TabInputKindCanvas:
			cv, err := q.CreateCanvas(r.Context(), store.CreateCanvasParams{ChannelID: c.ID, UpdatedBy: p.User.ID})
			if err != nil {
				return err
			}
			arg.CanvasID = cv.ID
		case api.TabInputKindList:
			l, err := q.CreateList(r.Context(), store.CreateListParams{ChannelID: c.ID, Columns: columns, BoardColumn: board})
			if err != nil {
				return err
			}
			arg.ListID = l.ID
		}
		var err error
		if tab, err = q.CreateChannelTab(r.Context(), arg); err != nil {
			return err
		}
		return emit(r.Context(), q, events.TabsChanged, TabsEvent{ChannelID: uuid(c.ID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "create tab", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, tabAPI(tab, c, role, p.User.ID))
}

func textOf(p *string) pgtype.Text {
	if p == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *p, Valid: true}
}

// tab loads a tab of a channel the user is a member of.
func (h *Handlers) tab(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.ChannelTab, store.Channel, access, bool) {
	t, err := h.Queries.GetChannelTab(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such tab."})
		return t, store.Channel{}, access{}, false
	}
	if err != nil {
		h.unavailable(w, r, "get tab", err)
		return t, store.Channel{}, access{}, false
	}
	c, role, ok := h.memberChannel(w, r, uuid(t.ChannelID), user)
	return t, c, role, ok
}

// UpdateChannelTab implements api.ServerInterface.
func (h *Handlers) UpdateChannelTab(w http.ResponseWriter, r *http.Request, tabID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	t, c, role, ok := h.tab(w, r, tabID, p.User)
	if !ok {
		return
	}
	if !canPost(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "Only people who can post here change tabs.")
		return
	}
	if !serverReadable(w, r, c) {
		return
	}
	var in api.UpdateChannelTabJSONBody
	if !decode(w, r, &in) {
		return
	}
	title := t.Title
	if in.Title != nil {
		if title, ok = tabTitle(*in.Title); !ok {
			badRequest(w, r, "A tab's title has 1 to 80 characters.")
			return
		}
	}
	var link pgtype.Text
	if in.Url != nil {
		u, ok := linkURL(*in.Url)
		if t.Kind != string(api.TabKindLink) || !ok {
			badRequest(w, r, "Only a link tab has an address, an http(s) one.")
			return
		}
		link = pgtype.Text{String: u, Valid: true}
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if t, err = q.RenameChannelTab(r.Context(), store.RenameChannelTabParams{ID: t.ID, Title: title, Url: link}); err != nil {
			return err
		}
		if in.Position != nil {
			tabs, err := q.ListChannelTabs(r.Context(), c.ID)
			if err != nil {
				return err
			}
			tabs = slices.DeleteFunc(tabs, func(o store.ChannelTab) bool { return o.ID == t.ID })
			at := min(*in.Position, len(tabs))
			tabs = slices.Insert(tabs, at, t)
			for i, o := range tabs {
				if err := q.SetChannelTabPosition(r.Context(), store.SetChannelTabPositionParams{ID: o.ID, Position: int32(i)}); err != nil { //nolint:gosec // at most MaxTabs
					return err
				}
			}
			t.Position = int32(at) //nolint:gosec // at most MaxTabs
		}
		return emit(r.Context(), q, events.TabsChanged, TabsEvent{ChannelID: uuid(c.ID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "update tab", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, tabAPI(t, c, role, p.User.ID))
}

// DeleteChannelTab implements api.ServerInterface.
func (h *Handlers) DeleteChannelTab(w http.ResponseWriter, r *http.Request, tabID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	t, c, role, ok := h.tab(w, r, tabID, p.User)
	if !ok {
		return
	}
	if !tabAPI(t, c, role, p.User.ID).CanDelete {
		forbidden(w, r, httpx.CodeForbidden, "Only who added the tab and the channel's managers delete it.")
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		switch {
		case t.CanvasID.Valid: // the tab goes with its canvas
			err = q.DeleteCanvas(r.Context(), t.CanvasID)
		case t.ListID.Valid:
			err = q.DeleteList(r.Context(), t.ListID)
		default:
			err = q.DeleteChannelTab(r.Context(), t.ID)
		}
		if err != nil {
			return err
		}
		return emit(r.Context(), q, events.TabsChanged, TabsEvent{ChannelID: uuid(c.ID).String()})
	})
	if err != nil {
		h.unavailable(w, r, "delete tab", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.TabDeleted, "channel", uuid(c.ID).String(),
		map[string]any{"title": t.Title, "kind": t.Kind})
	w.WriteHeader(http.StatusNoContent)
}

// --- canvases -----------------------------------------------------------------

func canvasAPI(cv store.GetCanvasRow, t store.ChannelTab, canEdit bool) api.Canvas {
	out := api.Canvas{
		Id: uuid(cv.ID), ChannelId: uuid(cv.ChannelID), Title: t.Title, Body: cv.Body,
		Version: int(cv.Version), UpdatedAt: cv.UpdatedAt, CanEdit: canEdit,
	}
	if cv.UpdatedBy.Valid {
		out.UpdatedBy = &api.Author{Id: uuid(cv.UpdatedBy), DisplayName: cv.UpdatedByName}
	}
	if cv.EditingBy.Valid && cv.EditingByName != "" {
		out.EditingBy = &api.Author{Id: uuid(cv.EditingBy), DisplayName: cv.EditingByName}
	}
	return out
}

// canvas loads a canvas of a channel the user is a member of.
func (h *Handlers) canvas(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.GetCanvasRow, store.ChannelTab, store.Channel, access, bool) {
	cv, err := h.Queries.GetCanvas(r.Context(), pgUUID(id))
	var t store.ChannelTab
	if err == nil {
		t, err = h.Queries.GetTabByCanvas(r.Context(), cv.ID)
	}
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such canvas."})
		return cv, t, store.Channel{}, access{}, false
	}
	if err != nil {
		h.unavailable(w, r, "get canvas", err)
		return cv, t, store.Channel{}, access{}, false
	}
	c, role, ok := h.memberChannel(w, r, uuid(cv.ChannelID), user)
	return cv, t, c, role, ok
}

// editableCanvas loads a canvas the user may write in.
func (h *Handlers) editableCanvas(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.GetCanvasRow, store.ChannelTab, bool) {
	cv, t, c, role, ok := h.canvas(w, r, id, user)
	if !ok {
		return cv, t, false
	}
	if !canPost(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "Only people who can post here edit canvases.")
		return cv, t, false
	}
	return cv, t, serverReadable(w, r, c)
}

// canvasChanged answers with the canvas as it is now and tells the channel.
func (h *Handlers) canvasChanged(w http.ResponseWriter, r *http.Request, status int, t store.ChannelTab, canEdit bool) {
	cv, err := h.Queries.GetCanvas(r.Context(), t.CanvasID)
	if err != nil {
		h.unavailable(w, r, "get canvas", err)
		return
	}
	out := canvasAPI(cv, t, canEdit)
	h.publish(r.Context(), events.CanvasUpdated, CanvasEvent{ChannelID: uuid(cv.ChannelID).String(), Canvas: out})
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	httpx.WriteJSON(w, status, out)
}

// GetCanvas implements api.ServerInterface.
func (h *Handlers) GetCanvas(w http.ResponseWriter, r *http.Request, canvasID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	cv, t, c, role, ok := h.canvas(w, r, canvasID, p.User)
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, canvasAPI(cv, t, canPost(c, role)))
}

func canvasBusy(w http.ResponseWriter, r *http.Request, cv store.GetCanvasRow) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeCanvasBusy,
		Detail: cv.EditingByName + " is editing this canvas."})
}

// StartEditingCanvas implements api.ServerInterface.
func (h *Handlers) StartEditingCanvas(w http.ResponseWriter, r *http.Request, canvasID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	cv, t, ok := h.editableCanvas(w, r, canvasID, p.User)
	if !ok {
		return
	}
	_, err := h.Queries.TakeCanvasTurn(r.Context(), store.TakeCanvasTurnParams{
		ID: cv.ID, UserID: p.User.ID, Seconds: int32(canvasTurn / time.Second),
	})
	if isNoRows(err) {
		canvasBusy(w, r, cv)
		return
	}
	if err != nil {
		h.unavailable(w, r, "take canvas turn", err)
		return
	}
	if cv.EditingBy == p.User.ID && cv.EditingByName != "" { // keeping the turn: nothing to tell
		cv.EditingUntil = pgtype.Timestamptz{Time: time.Now().Add(canvasTurn), Valid: true}
		httpx.WriteJSON(w, http.StatusOK, canvasAPI(cv, t, true))
		return
	}
	h.canvasChanged(w, r, http.StatusOK, t, true)
}

// StopEditingCanvas implements api.ServerInterface.
func (h *Handlers) StopEditingCanvas(w http.ResponseWriter, r *http.Request, canvasID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	cv, t, c, role, ok := h.canvas(w, r, canvasID, p.User)
	if !ok {
		return
	}
	_, err := h.Queries.EndCanvasTurn(r.Context(), store.EndCanvasTurnParams{ID: cv.ID, UserID: p.User.ID})
	if isNoRows(err) { // not editing (any more)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		h.unavailable(w, r, "end canvas turn", err)
		return
	}
	h.canvasChanged(w, r, http.StatusNoContent, t, canPost(c, role))
}

// SaveCanvas implements api.ServerInterface.
func (h *Handlers) SaveCanvas(w http.ResponseWriter, r *http.Request, canvasID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	cv, t, ok := h.editableCanvas(w, r, canvasID, p.User)
	if !ok {
		return
	}
	var in api.SaveCanvasJSONBody
	if !decodeLimit(w, r, &in, 512<<10) {
		return
	}
	if utf8.RuneCountInString(in.Body) > MaxCanvasBody || !utf8.ValidString(in.Body) {
		badRequest(w, r, "A canvas has up to 50,000 characters.")
		return
	}
	if cv.EditingByName != "" && cv.EditingBy != p.User.ID { // someone else's turn
		canvasBusy(w, r, cv)
		return
	}
	_, err := h.Queries.SaveCanvas(r.Context(), store.SaveCanvasParams{
		ID: cv.ID, Body: in.Body, UserID: p.User.ID, Version: int32(in.Version), //nolint:gosec // compared, never stored
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeCanvasChange,
			Detail: "Someone saved this canvas while you were editing it."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "save canvas", err)
		return
	}
	h.canvasChanged(w, r, http.StatusOK, t, true)
}

// --- lists --------------------------------------------------------------------

// cleanColumns checks a list's columns and the column its board groups by.
func cleanColumns(in []api.ListColumn, board *string) ([]api.ListColumn, *string, string) {
	if len(in) > MaxListColumns {
		return nil, nil, "A list has up to 20 columns."
	}
	out := make([]api.ListColumn, 0, len(in))
	seen := map[string]bool{}
	hasStatus := false
	for _, col := range in {
		col.Name = strings.TrimSpace(col.Name)
		switch {
		case !fieldIDRE.MatchString(col.Id):
			return nil, nil, "A column's id has 1 to 32 lowercase letters, digits or _."
		case seen[col.Id]:
			return nil, nil, "Two columns have the id " + col.Id + "."
		case col.Name == "" || utf8.RuneCountInString(col.Name) > 80:
			return nil, nil, "A column's name has 1 to 80 characters."
		}
		seen[col.Id] = true
		switch col.Kind {
		case api.ListColumnKindText, api.ListColumnKindNumber, api.ListColumnKindPerson,
			api.ListColumnKindDate, api.ListColumnKindCheckbox:
			col.Options = nil
		case api.ListColumnKindStatus:
			if hasStatus {
				return nil, nil, "A list has one status column."
			}
			hasStatus = true
			col.Options = nil
		case api.ListColumnKindSelect:
			opts := make([]string, 0, len(deref(col.Options)))
			for _, o := range deref(col.Options) {
				o = strings.TrimSpace(o)
				if o == "" || utf8.RuneCountInString(o) > 60 || slices.Contains(opts, o) {
					return nil, nil, "Options have 1 to 60 characters and differ from each other."
				}
				opts = append(opts, o)
			}
			if len(opts) < 1 || len(opts) > 30 {
				return nil, nil, "A choice column has 1 to 30 options."
			}
			col.Options = &opts
		default:
			return nil, nil, "Unknown column kind."
		}
		out = append(out, col)
	}
	if board != nil && *board != "" {
		i := slices.IndexFunc(out, func(c api.ListColumn) bool { return c.Id == *board })
		if i < 0 || (out[i].Kind != api.ListColumnKindStatus && out[i].Kind != api.ListColumnKindSelect) {
			return nil, nil, "The board groups by a status or choice column of the list."
		}
		return out, board, ""
	}
	return out, nil, ""
}

// cleanValue checks one value for its column; "" clears it.
func cleanValue(ctx context.Context, q store.Querier, workspace pgtype.UUID, col api.ListColumn, v string) (string, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "", true
	}
	switch col.Kind {
	case api.ListColumnKindText:
		return v, utf8.RuneCountInString(v) <= 2000
	case api.ListColumnKindNumber:
		_, err := strconv.ParseFloat(v, 64)
		return v, err == nil && len(v) <= 40
	case api.ListColumnKindSelect:
		return v, slices.Contains(deref(col.Options), v)
	case api.ListColumnKindStatus:
		return v, slices.Contains(statuses, v)
	case api.ListColumnKindDate:
		_, err := time.Parse(time.DateOnly, v)
		return v, err == nil
	case api.ListColumnKindCheckbox:
		return v, v == "true" || v == "false"
	case api.ListColumnKindPerson:
		id, err := guuid.Parse(v)
		if err != nil {
			return v, false
		}
		_, err = q.GetWorkspaceMemberName(ctx, store.GetWorkspaceMemberNameParams{WorkspaceID: workspace, UserID: pgUUID(id)})
		return id.String(), err == nil
	}
	return v, false
}

// derived is what a row's values say about it: who it is assigned to, whether
// it is done and when it is due.
func derived(columns []api.ListColumn, values map[string]string) (assignees []pgtype.UUID, done bool, due pgtype.Date) {
	assignees = []pgtype.UUID{}
	for _, col := range columns {
		v := values[col.Id]
		if v == "" {
			continue
		}
		switch col.Kind {
		case api.ListColumnKindPerson:
			if id, err := guuid.Parse(v); err == nil && !slices.Contains(assignees, pgUUID(id)) {
				assignees = append(assignees, pgUUID(id))
			}
		case api.ListColumnKindStatus:
			done = v == "done"
		case api.ListColumnKindDate:
			if t, err := time.Parse(time.DateOnly, v); err == nil && !due.Valid {
				due = pgtype.Date{Time: t, Valid: true}
			}
		}
	}
	return assignees, done, due
}

type listRef struct {
	list    store.List
	columns []api.ListColumn
	tab     store.ChannelTab
	channel store.Channel
	role    access
}

func (l listRef) column(id string) (api.ListColumn, bool) {
	i := slices.IndexFunc(l.columns, func(c api.ListColumn) bool { return c.Id == id })
	if i < 0 {
		return api.ListColumn{}, false
	}
	return l.columns[i], true
}

// listFor loads a list of a channel the user is a member of.
func (h *Handlers) listFor(w http.ResponseWriter, r *http.Request, id pgtype.UUID, user store.User) (listRef, bool) {
	var ref listRef
	l, err := h.Queries.GetList(r.Context(), id)
	if err == nil {
		ref.list = l
		ref.tab, err = h.Queries.GetTabByList(r.Context(), l.ID)
	}
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such list."})
		return ref, false
	}
	if err == nil {
		err = json.Unmarshal(l.Columns, &ref.columns)
	}
	if err != nil {
		h.unavailable(w, r, "get list", err)
		return ref, false
	}
	var ok bool
	ref.channel, ref.role, ok = h.memberChannel(w, r, uuid(l.ChannelID), user)
	return ref, ok
}

func listItemAPI(i store.ListItem) api.ListItem {
	values := api.ListValues{}
	_ = json.Unmarshal(i.Values, &values)
	return api.ListItem{Id: uuid(i.ID), ListId: uuid(i.ListID), Title: i.Title, Values: values,
		CreatedAt: i.CreatedAt, UpdatedAt: i.UpdatedAt}
}

func (h *Handlers) listChanged(ctx context.Context, q store.Querier, l listRef) error {
	return emit(ctx, q, events.ListChanged, ListEvent{ChannelID: uuid(l.channel.ID).String(), ListID: uuid(l.list.ID).String()})
}

// GetList implements api.ServerInterface.
func (h *Handlers) GetList(w http.ResponseWriter, r *http.Request, listID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	l, ok := h.listFor(w, r, pgUUID(listID), p.User)
	if !ok {
		return
	}
	h.writeList(w, r, l)
}

func (h *Handlers) writeList(w http.ResponseWriter, r *http.Request, l listRef) {
	items, err := h.Queries.ListListItems(r.Context(), l.list.ID)
	if err != nil {
		h.unavailable(w, r, "list items", err)
		return
	}
	out := api.ItemList{Id: uuid(l.list.ID), ChannelId: uuid(l.channel.ID), Title: l.tab.Title,
		Columns: l.columns, Items: make([]api.ListItem, len(items)), CanEdit: canPost(l.channel, l.role)}
	if l.list.BoardColumn.Valid {
		out.BoardColumn = &l.list.BoardColumn.String
	}
	for i, it := range items {
		out.Items[i] = listItemAPI(it)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// changeableList loads a list the user may change (removing rows included).
func (h *Handlers) changeableList(w http.ResponseWriter, r *http.Request, id pgtype.UUID, user store.User) (listRef, bool) {
	l, ok := h.listFor(w, r, id, user)
	if ok && !canPost(l.channel, l.role) {
		forbidden(w, r, httpx.CodeForbidden, "Only people who can post here change lists.")
		return l, false
	}
	return l, ok
}

// editableList loads a list the user may write in.
func (h *Handlers) editableList(w http.ResponseWriter, r *http.Request, id pgtype.UUID, user store.User) (listRef, bool) {
	l, ok := h.changeableList(w, r, id, user)
	return l, ok && serverReadable(w, r, l.channel)
}

// UpdateList implements api.ServerInterface.
func (h *Handlers) UpdateList(w http.ResponseWriter, r *http.Request, listID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	l, ok := h.editableList(w, r, pgUUID(listID), p.User)
	if !ok {
		return
	}
	var in api.ListInput
	if !decode(w, r, &in) {
		return
	}
	cols, board, problem := cleanColumns(in.Columns, in.BoardColumn)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	raw, _ := json.Marshal(cols)
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if l.list, err = q.UpdateList(r.Context(), store.UpdateListParams{ID: l.list.ID, Columns: raw, BoardColumn: textOf(board)}); err != nil {
			return err
		}
		l.columns = cols
		// Rows keep the values their columns still take.
		items, err := q.ListListItems(r.Context(), l.list.ID)
		if err != nil {
			return err
		}
		for _, it := range items {
			var old map[string]string
			if err := json.Unmarshal(it.Values, &old); err != nil {
				return err
			}
			values := map[string]string{}
			for id, v := range old {
				if col, ok := l.column(id); ok {
					if v, ok := cleanValue(r.Context(), q, l.channel.WorkspaceID, col, v); ok && v != "" {
						values[id] = v
					}
				}
			}
			if err := h.saveItem(r.Context(), q, l, it, it.Title, values, it.Position); err != nil {
				return err
			}
		}
		return h.listChanged(r.Context(), q, l)
	})
	if err != nil {
		h.unavailable(w, r, "update list", err)
		return
	}
	h.writeList(w, r, l)
}

func (h *Handlers) saveItem(ctx context.Context, q store.Querier, l listRef, it store.ListItem, title string, values map[string]string, position float64) error {
	raw, err := json.Marshal(values)
	if err != nil {
		return err
	}
	assignees, done, due := derived(l.columns, values)
	_, err = q.UpdateListItem(ctx, store.UpdateListItemParams{ID: it.ID, Title: title, Values: raw, Position: position,
		Assignees: assignees, Done: done, Due: due})
	return err
}

// itemValues checks values sent for a row and applies them over its current ones.
func itemValues(ctx context.Context, q store.Querier, l listRef, current map[string]string, in *api.ListValues) (map[string]string, string) {
	out := map[string]string{}
	for k, v := range current {
		out[k] = v
	}
	if in == nil {
		return out, ""
	}
	for id, v := range *in {
		col, ok := l.column(id)
		if !ok {
			return nil, "The list has no column " + id + "."
		}
		v, ok := cleanValue(ctx, q, l.channel.WorkspaceID, col, v)
		if !ok {
			return nil, "“" + col.Name + "” does not take this value."
		}
		if v == "" {
			delete(out, id)
		} else {
			out[id] = v
		}
	}
	return out, ""
}

func itemTitle(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, s != "" && utf8.RuneCountInString(s) <= 500
}

// CreateListItem implements api.ServerInterface.
func (h *Handlers) CreateListItem(w http.ResponseWriter, r *http.Request, listID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	l, ok := h.editableList(w, r, pgUUID(listID), p.User)
	if !ok {
		return
	}
	var in api.ListItemInput
	if !decode(w, r, &in) {
		return
	}
	title, ok := itemTitle(in.Title)
	if !ok {
		badRequest(w, r, "A row's title has 1 to 500 characters.")
		return
	}
	values, problem := itemValues(r.Context(), h.Queries, l, nil, in.Values)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	n, err := h.Queries.CountListItems(r.Context(), l.list.ID)
	if err != nil {
		h.unavailable(w, r, "count items", err)
		return
	}
	if n >= MaxListItems {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeListFull,
			Detail: "A list has up to 2,000 rows."})
		return
	}
	raw, _ := json.Marshal(values)
	assignees, done, due := derived(l.columns, values)
	var item store.ListItem
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		item, err = q.CreateListItem(r.Context(), store.CreateListItemParams{ListID: l.list.ID, Title: title, Values: raw,
			Assignees: assignees, Done: done, Due: due, CreatedBy: p.User.ID})
		if err != nil {
			return err
		}
		return h.listChanged(r.Context(), q, l)
	})
	if err != nil {
		h.unavailable(w, r, "create item", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, listItemAPI(item))
}

// item loads a row of a list the user may change; writing text into it
// (not removing it) also needs a channel the server may read.
func (h *Handlers) item(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User, writes bool) (store.ListItem, listRef, bool) {
	it, err := h.Queries.GetListItem(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such row."})
		return it, listRef{}, false
	}
	if err != nil {
		h.unavailable(w, r, "get item", err)
		return it, listRef{}, false
	}
	if !writes {
		l, ok := h.changeableList(w, r, it.ListID, user)
		return it, l, ok
	}
	l, ok := h.editableList(w, r, it.ListID, user)
	return it, l, ok
}

// UpdateListItem implements api.ServerInterface.
func (h *Handlers) UpdateListItem(w http.ResponseWriter, r *http.Request, itemID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	it, l, ok := h.item(w, r, itemID, p.User, true)
	if !ok {
		return
	}
	var in api.UpdateListItemJSONBody
	if !decode(w, r, &in) {
		return
	}
	title := it.Title
	if in.Title != nil {
		if title, ok = itemTitle(*in.Title); !ok {
			badRequest(w, r, "A row's title has 1 to 500 characters.")
			return
		}
	}
	var current map[string]string
	if err := json.Unmarshal(it.Values, &current); err != nil {
		h.unavailable(w, r, "read item", err)
		return
	}
	values, problem := itemValues(r.Context(), h.Queries, l, current, in.Values)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		position := it.Position
		if in.Before != nil || (in.ToEnd != nil && *in.ToEnd) {
			items, err := q.ListListItems(r.Context(), l.list.ID)
			if err != nil {
				return err
			}
			if position, err = moveTo(r.Context(), q, items, it.ID, in.Before); err != nil {
				return err
			}
		}
		if err := h.saveItem(r.Context(), q, l, it, title, values, position); err != nil {
			return err
		}
		return h.listChanged(r.Context(), q, l)
	})
	if isNoRows(err) {
		badRequest(w, r, "Move the row before a row of the same list.")
		return
	}
	if err != nil {
		h.unavailable(w, r, "update item", err)
		return
	}
	updated, err := h.Queries.GetListItem(r.Context(), it.ID)
	if err != nil {
		h.unavailable(w, r, "get item", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, listItemAPI(updated))
}

// moveTo finds the position of a row moved before another (or to the end),
// numbering the rows again when there is no room left between two of them.
func moveTo(ctx context.Context, q store.Querier, items []store.ListItem, id pgtype.UUID, before *openapi_types.UUID) (float64, error) {
	items = slices.DeleteFunc(items, func(i store.ListItem) bool { return i.ID == id })
	at := len(items)
	if before != nil {
		at = slices.IndexFunc(items, func(i store.ListItem) bool { return uuid(i.ID) == *before })
		if at < 0 {
			return 0, pgx.ErrNoRows
		}
	}
	lo, hi := 0.0, 0.0
	if at > 0 {
		lo = items[at-1].Position
	}
	if at < len(items) {
		hi = items[at].Position
	} else {
		return lo + 1, nil
	}
	if at == 0 {
		lo = hi - 2
	}
	if hi-lo > 1e-6 {
		return (lo + hi) / 2, nil
	}
	// Number the rows 1, 2, … again, leaving room at the new place.
	sort.SliceStable(items, func(a, b int) bool { return items[a].Position < items[b].Position })
	for i, o := range items {
		n := float64(i + 1)
		if i >= at {
			n++
		}
		if err := q.SetListItemPosition(ctx, store.SetListItemPositionParams{ID: o.ID, Position: n}); err != nil {
			return 0, err
		}
	}
	return float64(at + 1), nil
}

// DeleteListItem implements api.ServerInterface.
func (h *Handlers) DeleteListItem(w http.ResponseWriter, r *http.Request, itemID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	it, l, ok := h.item(w, r, itemID, p.User, false)
	if !ok {
		return
	}
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if err := q.DeleteListItem(r.Context(), it.ID); err != nil {
			return err
		}
		return h.listChanged(r.Context(), q, l)
	})
	if err != nil {
		h.unavailable(w, r, "delete item", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListAssignedItems implements api.ServerInterface.
func (h *Handlers) ListAssignedItems(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	rows, err := h.Queries.ListAssignedItems(r.Context(), store.ListAssignedItemsParams{WorkspaceID: pgUUID(workspaceID), UserID: p.User.ID})
	if err != nil {
		h.unavailable(w, r, "list assigned items", err)
		return
	}
	out := make([]api.AssignedItem, len(rows))
	for i, row := range rows {
		out[i] = api.AssignedItem{
			Item: listItemAPI(store.ListItem{ID: row.ID, ListID: row.ListID, Title: row.Title, Values: row.Values,
				CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}),
			ListTitle: row.ListTitle, TabId: uuid(row.TabID), ChannelId: uuid(row.ChannelID), ChannelName: row.ChannelName,
		}
		if row.Due.Valid {
			out[i].Due = &openapi_types.Date{Time: row.Due.Time}
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.AssignedItem{"items": out})
}
