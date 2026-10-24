// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
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

// Data spillage: a message that holds what must not be here is reported,
// a designated reviewer removes it everywhere (also where a legal hold would
// keep it) or dismisses the report, and an incident report says what
// happened without the content.

const (
	CodeAlreadyReported = "already_reported"
	removedBody         = "[removed: spillage]"
)

// isSpillageReviewer: the workspace's chosen reviewers, or its owners when
// none are chosen.
func isSpillageReviewer(ws store.Workspace, user pgtype.UUID, role string) bool {
	if len(ws.SpillageReviewers) == 0 {
		return role == WorkspaceOwner
	}
	return slices.Contains(ws.SpillageReviewers, user)
}

func spillageAPI(r store.SpillageReport, channel, reporter, decider, author, body string) api.SpillageReport {
	out := api.SpillageReport{Id: uuid(r.ID), ChannelName: channel, Reason: r.Reason, Status: api.SpillageReportStatus(r.Status),
		ReportedBy: reporter, CreatedAt: r.CreatedAt, DecidedAt: timeOf(r.DecidedAt), Note: ptr(r.Note), DecidedBy: ptr(decider)}
	if r.ChannelID.Valid {
		out.ChannelId = ptr(uuid(r.ChannelID))
	}
	if r.MessageID.Valid {
		out.MessageId = ptr(uuid(r.MessageID))
	}
	// The content is shown to the reviewers only while they decide.
	if r.Status == "open" {
		out.AuthorName, out.Body = ptr(author), ptr(body)
	}
	return out
}

// ReportSpillage implements api.ServerInterface.
func (h *Handlers) ReportSpillage(w http.ResponseWriter, r *http.Request, channelID, messageID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.ReportSpillageJSONBody
	if !decode(w, r, &in) {
		return
	}
	reason := strings.TrimSpace(in.Reason)
	if reason == "" || utf8.RuneCountInString(reason) > 1000 {
		badRequest(w, r, "Say in 1 to 1000 characters why this must not be here.")
		return
	}
	c, _, m, ok := h.message(w, r, channelID, messageID, p.User)
	if !ok {
		return
	}
	if m.DeletedAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The message was deleted."})
		return
	}
	rep, err := h.Queries.CreateSpillageReport(r.Context(), store.CreateSpillageReportParams{
		WorkspaceID: c.WorkspaceID, ChannelID: c.ID, MessageID: m.ID, ReportedBy: p.User.ID, Reason: reason,
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeAlreadyReported,
			Detail: "This message was reported already; the reviewers are on it."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "report spillage", err)
		return
	}
	h.record(r, c.WorkspaceID, audit.SpillageReported, "message", uuid(m.ID).String(), map[string]any{"channel": c.Name, "report": uuid(rep.ID).String()})
	httpx.WriteJSON(w, http.StatusCreated, spillageAPI(rep, c.Name, p.User.DisplayName, "", m.AuthorName, m.Body))
}

// reviewedWorkspace loads a workspace the user reviews spillage of.
func (h *Handlers) reviewedWorkspace(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID, user store.User) (store.Workspace, bool) {
	role, ok := h.workspaceRole(w, r, uuid(workspaceID), user)
	if !ok {
		return store.Workspace{}, false
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return ws, false
	}
	if !isSpillageReviewer(ws, user.ID, role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's spillage reviewers see and decide reports.")
		return ws, false
	}
	return ws, true
}

// ListSpillageReports implements api.ServerInterface.
func (h *Handlers) ListSpillageReports(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.ListSpillageReportsParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, ok := h.reviewedWorkspace(w, r, pgUUID(workspaceID), p.User); !ok {
		return
	}
	status := ""
	if params.Status != nil {
		status = string(*params.Status)
	}
	rows, err := h.Queries.ListSpillageReports(r.Context(), store.ListSpillageReportsParams{WorkspaceID: pgUUID(workspaceID), Status: status})
	if err != nil {
		h.unavailable(w, r, "list spillage reports", err)
		return
	}
	out := make([]api.SpillageReport, 0, len(rows))
	for _, x := range rows {
		rep := store.SpillageReport{ID: x.ID, WorkspaceID: x.WorkspaceID, ChannelID: x.ChannelID, MessageID: x.MessageID,
			MessageRef: x.MessageRef, ReportedBy: x.ReportedBy, Reason: x.Reason, Status: x.Status, CreatedAt: x.CreatedAt,
			DecidedBy: x.DecidedBy, DecidedAt: x.DecidedAt, Note: x.Note}
		out = append(out, spillageAPI(rep, x.ChannelName, x.ReporterName, x.DeciderName, x.AuthorName, x.Body))
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Reports []api.SpillageReport `json:"reports"`
	}{out})
}

// SetSpillageReviewers implements api.ServerInterface.
func (h *Handlers) SetSpillageReviewers(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.SetSpillageReviewersJSONBody
	if !decode(w, r, &in) {
		return
	}
	if !h.requireWorkspaceOwner(w, r, workspaceID, p.User, "Only the workspace's owners choose spillage reviewers.") {
		return
	}
	if len(in.UserIds) > 50 {
		badRequest(w, r, "At most 50 reviewers.")
		return
	}
	ids := uuidsOf(in.UserIds)
	for _, id := range ids {
		role, err := h.Queries.GetWorkspaceRole(r.Context(), store.GetWorkspaceRoleParams{WorkspaceID: pgUUID(workspaceID), UserID: id})
		if err != nil || role == "" || role == WorkspaceGuest {
			badRequest(w, r, "Reviewers are members of the workspace (not guests).")
			return
		}
	}
	if err := h.Queries.SetSpillageReviewers(r.Context(), store.SetSpillageReviewersParams{ID: pgUUID(workspaceID), Reviewers: ids}); err != nil {
		h.unavailable(w, r, "set spillage reviewers", err)
		return
	}
	h.record(r, pgUUID(workspaceID), audit.SpillageReviewersChanged, "workspace", workspaceID.String(), map[string]any{"reviewers": len(ids)})
	h.publish(r.Context(), events.WorkspaceUpdated, WorkspaceEvent{WorkspaceID: workspaceID.String()})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) spillageReport(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.SpillageReport, bool) {
	rep, err := h.Queries.GetSpillageReport(r.Context(), pgUUID(id))
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such report."})
		return rep, false
	}
	if err != nil {
		h.unavailable(w, r, "get spillage report", err)
		return rep, false
	}
	if _, ok := h.reviewedWorkspace(w, r, rep.WorkspaceID, user); !ok {
		return rep, false
	}
	return rep, true
}

// DecideSpillage implements api.ServerInterface.
func (h *Handlers) DecideSpillage(w http.ResponseWriter, r *http.Request, reportID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	var in api.DecideSpillageJSONBody
	if !decode(w, r, &in) {
		return
	}
	note := strings.TrimSpace(deref1(in.Note))
	if utf8.RuneCountInString(note) > 2000 || (in.Decision != api.DecideSpillageJSONBodyDecisionRemove && in.Decision != api.DecideSpillageJSONBodyDecisionDismiss) {
		badRequest(w, r, "decision is remove or dismiss, with a note of up to 2000 characters.")
		return
	}
	rep, ok := h.spillageReport(w, r, reportID, p.User)
	if !ok {
		return
	}
	if rep.Status != "open" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "already_decided", Detail: "This report was decided already."})
		return
	}
	incident := map[string]any{
		"report_id": uuid(rep.ID).String(), "workspace_id": uuid(rep.WorkspaceID).String(),
		"message_id": uuid(rep.MessageRef).String(), "reason": rep.Reason, "reported_at": rep.CreatedAt,
		"decided_at": time.Now().UTC(), "note": note,
		"decided_by": map[string]any{"id": uuid(p.User.ID).String(), "name": p.User.DisplayName},
	}
	if rep.ReportedBy.Valid {
		if u, err := h.Queries.GetUser(r.Context(), rep.ReportedBy); err == nil {
			incident["reported_by"] = map[string]any{"id": uuid(u.ID).String(), "name": u.DisplayName}
		}
	}
	status := "dismissed"
	var c store.Channel
	var msg store.GetMessageRow
	removed := in.Decision == api.DecideSpillageJSONBodyDecisionRemove && rep.MessageID.Valid
	if removed {
		status = "removed"
		var err error
		if c, err = h.Queries.GetChannel(r.Context(), rep.ChannelID); err != nil {
			h.unavailable(w, r, "get channel", err)
			return
		}
		if msg, err = h.Queries.GetMessage(r.Context(), store.GetMessageParams{ID: rep.MessageID, ChannelID: rep.ChannelID}); err != nil {
			h.unavailable(w, r, "get message", err)
			return
		}
		// Evidence without the content: a fingerprint, who wrote it and who could see it.
		sum := sha256.Sum256([]byte(msg.Body))
		exposure, err := h.Queries.SpillageExposure(r.Context(), c.ID)
		if err != nil {
			h.unavailable(w, r, "spillage exposure", err)
			return
		}
		seen := make([]map[string]string, 0, len(exposure))
		for _, e := range exposure {
			seen = append(seen, map[string]string{"id": uuid(e.ID).String(), "name": e.DisplayName})
		}
		shared, _ := h.Queries.ListChannelShares(r.Context(), c.ID)
		servers := make([]string, 0, len(shared))
		for _, s := range shared {
			servers = append(servers, s.ConnectionName)
		}
		incident["channel"] = map[string]any{"id": uuid(c.ID).String(), "name": c.Name, "visibility": c.Visibility}
		incident["message"] = map[string]any{"author": map[string]any{"id": uuid(msg.AuthorID).String(), "name": msg.AuthorName},
			"written_at": msg.CreatedAt, "sha256": hex.EncodeToString(sum[:]), "length": utf8.RuneCountInString(msg.Body),
			"edited": msg.EditedAt.Valid, "in_thread": msg.RootID.Valid}
		incident["exposure"] = map[string]any{"people": seen, "count": len(seen), "shared_with_servers": servers}
	}
	var decided store.SpillageReport
	var files []store.DetachMessageFilesRow
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		if removed {
			counts, err := q.RedactMessage(r.Context(), store.RedactMessageParams{ID: msg.ID, RemovedBy: p.User.ID})
			if err != nil {
				return err
			}
			if files, err = q.DetachMessageFiles(r.Context(), msg.ID); err != nil {
				return err
			}
			list := make([]map[string]any, 0, len(files))
			for _, f := range files {
				list = append(list, map[string]any{"id": uuid(f.ID).String(), "name": f.Name, "size": f.Size, "content_type": f.ContentType})
			}
			incident["removed"] = map[string]any{"edits": counts.Edits, "reactions": counts.Reactions, "mentions": counts.Mentions,
				"saved": counts.Saved, "files": list}
			ref := MessageRef{ID: uuid(msg.ID).String(), ChannelID: uuid(c.ID).String()}
			if msg.RootID.Valid {
				ref.RootID = uuid(msg.RootID).String()
			}
			// Every device drops it; shared servers are told to delete it too.
			if err := emit(r.Context(), q, events.MessageDeleted, ref); err != nil {
				return err
			}
		}
		incident["decision"] = status
		raw, _ := json.Marshal(incident)
		var err error
		decided, err = q.DecideSpillageReport(r.Context(), store.DecideSpillageReportParams{
			ID: rep.ID, Status: status, DecidedBy: p.User.ID, Note: note, Report: raw,
		})
		return err
	})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "already_decided", Detail: "This report was decided already."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "decide spillage", err)
		return
	}
	// The bytes go now, not with the next cleanup.
	if h.Files != nil && h.Files.Store != nil {
		for _, f := range files {
			ctx := context.WithoutCancel(r.Context())
			_ = h.Files.Store.Remove(ctx, fileKey(f.ID))
			_ = h.Files.Store.Remove(ctx, thumbKey(f.ID))
		}
	}
	h.record(r, rep.WorkspaceID, audit.SpillageDecided, "message", uuid(rep.MessageRef).String(), map[string]any{
		"report": uuid(rep.ID).String(), "decision": status, "files": len(files)})
	httpx.WriteJSON(w, http.StatusOK, spillageAPI(decided, c.Name, "", p.User.DisplayName, "", ""))
}

// GetSpillageIncident implements api.ServerInterface.
func (h *Handlers) GetSpillageIncident(w http.ResponseWriter, r *http.Request, reportID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	rep, ok := h.spillageReport(w, r, reportID, p.User)
	if !ok {
		return
	}
	if rep.Status == "open" {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The report is not decided yet."})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="cenacle-spillage-`+uuid(rep.ID).String()+`.json"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(rep.Report)
}
