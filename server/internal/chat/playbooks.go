// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
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

// CodeRunFinished answers changes to a finished run.
const CodeRunFinished = "run_finished"

// runItem is a checklist item of a run with its state.
type runItem struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	DoneAt      *time.Time `json:"done_at"`
	DoneBy      *string    `json:"done_by"`
	Skipped     bool       `json:"skipped"`
	AssigneeID  *string    `json:"assignee_id"`
}

type runChecklist struct {
	Title string    `json:"title"`
	Items []runItem `json:"items"`
}

// cleanChecklists checks a playbook's checklists as sent.
func cleanChecklists(in []api.PlaybookChecklist) ([]api.PlaybookChecklist, string) {
	if len(in) == 0 || len(in) > 20 {
		return nil, "A playbook has 1 to 20 checklists."
	}
	out := make([]api.PlaybookChecklist, len(in))
	for i, c := range in {
		c.Title = strings.TrimSpace(c.Title)
		if c.Title == "" || utf8.RuneCountInString(c.Title) > 120 {
			return nil, "A checklist's title has 1 to 120 characters."
		}
		if len(c.Items) == 0 || len(c.Items) > 50 {
			return nil, "A checklist has 1 to 50 items."
		}
		for j, it := range c.Items {
			it.Title = strings.TrimSpace(it.Title)
			if it.Title == "" || utf8.RuneCountInString(it.Title) > 200 {
				return nil, "An item's title has 1 to 200 characters."
			}
			if it.Description != nil {
				d := strings.TrimSpace(*it.Description)
				if utf8.RuneCountInString(d) > 1000 {
					return nil, "An item's description is longer than 1000 characters."
				}
				it.Description = &d
			}
			c.Items[j] = it
		}
		out[i] = c
	}
	return out, ""
}

func playbookAPI(p store.Playbook, active int32) api.Playbook {
	out := api.Playbook{Id: uuid(p.ID), Name: p.Name, Description: p.Description, UpdatedAt: p.UpdatedAt,
		RunsActive: int(active), Checklists: []api.PlaybookChecklist{}}
	_ = json.Unmarshal(p.Checklists, &out.Checklists)
	return out
}

func runAPI(r store.PlaybookRun, owner string) api.Run {
	out := api.Run{Id: uuid(r.ID), ChannelId: uuid(r.ChannelID), Name: r.Name, Status: api.RunStatus(r.Status),
		CreatedAt: r.CreatedAt, FinishedAt: timePtr(r.FinishedAt)}
	if r.PlaybookID.Valid {
		out.PlaybookId = ptr(uuid(r.PlaybookID))
	}
	if r.OwnerID.Valid {
		out.Owner = &api.Author{Id: uuid(r.OwnerID), DisplayName: owner}
	}
	var lists []runChecklist
	_ = json.Unmarshal(r.Checklists, &lists)
	raw, _ := json.Marshal(lists)
	_ = json.Unmarshal(raw, &out.Checklists)
	if out.Checklists == nil {
		out.Checklists = []api.RunChecklist{}
	}
	return out
}

// ListPlaybooks implements api.ServerInterface.
func (h *Handlers) ListPlaybooks(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	rows, err := h.Queries.ListPlaybooks(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "list playbooks", err)
		return
	}
	out := make([]api.Playbook, len(rows))
	for i, row := range rows {
		out[i] = playbookAPI(store.Playbook{ID: row.ID, WorkspaceID: row.WorkspaceID, Name: row.Name,
			Description: row.Description, Checklists: row.Checklists, UpdatedAt: row.UpdatedAt}, row.RunsActive)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Playbook{"playbooks": out})
}

func playbookInput(in api.PlaybookInput) (name, description string, checklists []byte, problem string) {
	name = strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 120 {
		return "", "", nil, "A playbook's name has 1 to 120 characters."
	}
	if in.Description != nil {
		description = strings.TrimSpace(*in.Description)
	}
	if utf8.RuneCountInString(description) > 4000 {
		return "", "", nil, "The description is longer than 4000 characters."
	}
	lists, problem := cleanChecklists(in.Checklists)
	if problem != "" {
		return "", "", nil, problem
	}
	checklists, _ = json.Marshal(lists)
	return name, description, checklists, ""
}

// CreatePlaybook implements api.ServerInterface.
func (h *Handlers) CreatePlaybook(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.PlaybookInput
	if !decode(w, r, &in) || !h.requireWorkspaceAdmin(w, r, workspaceID, p.User, "Only the workspace's owners and admins write playbooks.") {
		return
	}
	name, description, lists, problem := playbookInput(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	pb, err := h.Queries.CreatePlaybook(r.Context(), store.CreatePlaybookParams{
		WorkspaceID: pgUUID(workspaceID), Name: name, Description: description, Checklists: lists, CreatedBy: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "create playbook", err)
		return
	}
	h.record(r, pb.WorkspaceID, audit.PlaybookChanged, "playbook", uuid(pb.ID).String(), map[string]any{"name": name, "change": "created"})
	httpx.WriteJSON(w, http.StatusCreated, playbookAPI(pb, 0))
}

// adminPlaybook loads a playbook of a workspace the user administers.
func (h *Handlers) adminPlaybook(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.Playbook, bool) {
	pb, err := h.Queries.GetPlaybook(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such playbook."})
		return pb, false
	}
	if err != nil {
		h.unavailable(w, r, "get playbook", err)
		return pb, false
	}
	return pb, h.requireWorkspaceAdmin(w, r, uuid(pb.WorkspaceID), user, "Only the workspace's owners and admins change playbooks.")
}

// UpdatePlaybook implements api.ServerInterface.
func (h *Handlers) UpdatePlaybook(w http.ResponseWriter, r *http.Request, playbookID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.PlaybookInput
	if !decode(w, r, &in) {
		return
	}
	pb, ok := h.adminPlaybook(w, r, playbookID, p.User)
	if !ok {
		return
	}
	name, description, lists, problem := playbookInput(in)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	pb, err := h.Queries.UpdatePlaybook(r.Context(), store.UpdatePlaybookParams{ID: pb.ID, Name: name, Description: description, Checklists: lists})
	if err != nil {
		h.unavailable(w, r, "update playbook", err)
		return
	}
	active, err := h.Queries.CountActiveRuns(r.Context(), pb.ID)
	if err != nil {
		h.unavailable(w, r, "count runs", err)
		return
	}
	h.record(r, pb.WorkspaceID, audit.PlaybookChanged, "playbook", uuid(pb.ID).String(), map[string]any{"name": name, "change": "updated"})
	httpx.WriteJSON(w, http.StatusOK, playbookAPI(pb, active))
}

// ArchivePlaybook implements api.ServerInterface.
func (h *Handlers) ArchivePlaybook(w http.ResponseWriter, r *http.Request, playbookID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	pb, ok := h.adminPlaybook(w, r, playbookID, p.User)
	if !ok {
		return
	}
	if _, err := h.Queries.ArchivePlaybook(r.Context(), pb.ID); err != nil {
		h.unavailable(w, r, "archive playbook", err)
		return
	}
	h.record(r, pb.WorkspaceID, audit.PlaybookChanged, "playbook", uuid(pb.ID).String(), map[string]any{"name": pb.Name, "change": "archived"})
	w.WriteHeader(http.StatusNoContent)
}

// RunEvent is the data of run.updated.
type RunEvent struct {
	ChannelID string  `json:"channel_id"`
	Run       api.Run `json:"run"`
}

// StartRun implements api.ServerInterface.
func (h *Handlers) StartRun(w http.ResponseWriter, r *http.Request, playbookID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.StartRunJSONBody
	if !decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 120 {
		badRequest(w, r, "A run's name has 1 to 120 characters.")
		return
	}
	pb, err := h.Queries.GetPlaybook(r.Context(), pgUUID(playbookID))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such playbook."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get playbook", err)
		return
	}
	c, role, ok := h.memberChannel(w, r, in.ChannelId, p.User)
	if !ok {
		return
	}
	if c.WorkspaceID != pb.WorkspaceID || !canPost(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "Start runs in channels of the playbook's workspace you can post in.")
		return
	}
	if !serverReadable(w, r, c) { // the run's name is kept as the server reads it
		return
	}
	var lists []api.PlaybookChecklist
	_ = json.Unmarshal(pb.Checklists, &lists)
	runLists := make([]runChecklist, len(lists))
	for i, l := range lists {
		runLists[i] = runChecklist{Title: l.Title, Items: make([]runItem, len(l.Items))}
		for j, it := range l.Items {
			runLists[i].Items[j] = runItem{Title: it.Title}
			if it.Description != nil {
				runLists[i].Items[j].Description = *it.Description
			}
		}
	}
	raw, _ := json.Marshal(runLists)
	var run store.PlaybookRun
	err = h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		run, err = q.CreateRun(r.Context(), store.CreateRunParams{
			PlaybookID: pb.ID, WorkspaceID: pb.WorkspaceID, ChannelID: c.ID, Name: name, OwnerID: p.User.ID, Checklists: raw,
		})
		if err != nil {
			return err
		}
		body := fmt.Sprintf("▶️ Started **%s** (playbook “%s”).", name, pb.Name)
		if _, err := postMessage(r.Context(), q, c, p.User, body, "run-"+uuid(run.ID).String(), []byte("[]")); err != nil && !errors.Is(err, errEncrypted) { // encrypted channels get no notice
			return err
		}
		return emit(r.Context(), q, events.RunUpdated, RunEvent{ChannelID: uuid(c.ID).String(), Run: runAPI(run, p.User.DisplayName)})
	})
	if err != nil {
		h.unavailable(w, r, "start run", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, runAPI(run, p.User.DisplayName))
}

func (h *Handlers) ownerName(r *http.Request, run store.PlaybookRun) string {
	if !run.OwnerID.Valid {
		return ""
	}
	u, err := h.Queries.GetUser(r.Context(), run.OwnerID)
	if err != nil {
		return ""
	}
	return u.DisplayName
}

// runsWithOwners answers runs with their owners' names.
func (h *Handlers) runsWithOwners(w http.ResponseWriter, r *http.Request, runs []store.PlaybookRun) {
	owners := []pgtype.UUID{}
	for _, run := range runs {
		if run.OwnerID.Valid {
			owners = append(owners, run.OwnerID)
		}
	}
	people, err := h.Queries.GetUsersByIDs(r.Context(), owners)
	if err != nil {
		h.unavailable(w, r, "load owners", err)
		return
	}
	names := map[pgtype.UUID]string{}
	for _, u := range people {
		names[u.ID] = u.DisplayName
	}
	out := make([]api.Run, len(runs))
	for i, run := range runs {
		out[i] = runAPI(run, names[run.OwnerID])
	}
	httpx.WriteJSON(w, http.StatusOK, map[string][]api.Run{"runs": out})
}

// ListChannelRuns implements api.ServerInterface.
func (h *Handlers) ListChannelRuns(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	c, _, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	runs, err := h.Queries.ListChannelRuns(r.Context(), c.ID)
	if err != nil {
		h.unavailable(w, r, "list runs", err)
		return
	}
	h.runsWithOwners(w, r, runs)
}

// ListWorkspaceRuns implements api.ServerInterface: the runs in progress in
// the channels the person is in.
func (h *Handlers) ListWorkspaceRuns(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.workspaceRole(w, r, workspaceID, p.User); !ok {
		return
	}
	runs, err := h.Queries.ListWorkspaceActiveRuns(r.Context(), store.ListWorkspaceActiveRunsParams{
		WorkspaceID: pgUUID(workspaceID), UserID: p.User.ID,
	})
	if err != nil {
		h.unavailable(w, r, "list runs", err)
		return
	}
	h.runsWithOwners(w, r, runs)
}

// memberRun loads a run in a channel the user belongs to.
func (h *Handlers) memberRun(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.PlaybookRun, store.Channel, access, bool) {
	run, err := h.Queries.GetRun(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such run."})
		return run, store.Channel{}, access{}, false
	}
	if err != nil {
		h.unavailable(w, r, "get run", err)
		return run, store.Channel{}, access{}, false
	}
	c, role, ok := h.memberChannel(w, r, uuid(run.ChannelID), user)
	return run, c, role, ok
}

// UpdateRunItem implements api.ServerInterface.
func (h *Handlers) UpdateRunItem(w http.ResponseWriter, r *http.Request, runID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.UpdateRunItemJSONBody
	if !decode(w, r, &in) {
		return
	}
	run, c, role, ok := h.memberRun(w, r, runID, p.User)
	if !ok {
		return
	}
	if !canPost(c, role) {
		forbidden(w, r, httpx.CodeForbidden, "You cannot post in this run's channel.")
		return
	}
	if run.Status != "active" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeRunFinished, Detail: "The run is finished."})
		return
	}
	var lists []runChecklist
	_ = json.Unmarshal(run.Checklists, &lists)
	if in.Checklist < 0 || in.Checklist >= len(lists) || in.Item < 0 || in.Item >= len(lists[in.Checklist].Items) {
		badRequest(w, r, "No such item.")
		return
	}
	item := &lists[in.Checklist].Items[in.Item]
	if in.Done != nil {
		if *in.Done {
			now, by := time.Now().UTC(), uuid(p.User.ID).String()
			item.DoneAt, item.DoneBy, item.Skipped = &now, &by, false
		} else {
			item.DoneAt, item.DoneBy = nil, nil
		}
	}
	if in.Skipped != nil {
		item.Skipped = *in.Skipped
		if item.Skipped {
			item.DoneAt, item.DoneBy = nil, nil
		}
	}
	if in.AssigneeId != nil {
		a := in.AssigneeId.String()
		item.AssigneeID = &a
	}
	raw, _ := json.Marshal(lists)
	var updated store.PlaybookRun
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if updated, err = q.SetRunChecklists(r.Context(), store.SetRunChecklistsParams{ID: run.ID, Checklists: raw}); err != nil {
			return err
		}
		return emit(r.Context(), q, events.RunUpdated, RunEvent{ChannelID: uuid(c.ID).String(), Run: runAPI(updated, h.ownerName(r, updated))})
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeRunFinished, Detail: "The run is finished."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "update run", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, runAPI(updated, h.ownerName(r, updated)))
}

// FinishRun implements api.ServerInterface.
func (h *Handlers) FinishRun(w http.ResponseWriter, r *http.Request, runID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	run, c, role, ok := h.memberRun(w, r, runID, p.User)
	if !ok {
		return
	}
	if run.OwnerID != p.User.ID && !canManage(c, role) && !role.admin() {
		forbidden(w, r, httpx.CodeForbidden, "Only the run's owner or a channel manager finishes it.")
		return
	}
	var finished store.PlaybookRun
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		var err error
		if finished, err = q.FinishRun(r.Context(), run.ID); err != nil {
			return err
		}
		body := fmt.Sprintf("✅ Finished **%s**.", run.Name)
		if _, err := postMessage(r.Context(), q, c, p.User, body, "run-done-"+uuid(run.ID).String(), []byte("[]")); err != nil && !errors.Is(err, errEncrypted) { // encrypted channels get no notice
			return err
		}
		return emit(r.Context(), q, events.RunUpdated, RunEvent{ChannelID: uuid(c.ID).String(), Run: runAPI(finished, h.ownerName(r, finished))})
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeRunFinished, Detail: "The run is finished."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "finish run", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, runAPI(finished, h.ownerName(r, finished)))
}
