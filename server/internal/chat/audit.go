// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// record writes an audit event of a workspace for the request's user.
func (h *Handlers) record(r *http.Request, workspace pgtype.UUID, action, targetType, targetID string, detail map[string]any) {
	p, _ := auth.PrincipalFrom(r.Context())
	h.Audit.Record(r.Context(), audit.Event{
		Actor: p.User.ID, Workspace: workspace, Action: action,
		TargetType: targetType, TargetID: targetID, IP: p.IP, Detail: detail,
	})
}

// ListWorkspaceAudit implements api.ServerInterface.
func (h *Handlers) ListWorkspaceAudit(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.ListWorkspaceAuditParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	role, ok := h.workspaceRole(w, r, workspaceID, p.User)
	if !ok {
		return
	}
	if !isWorkspaceAdmin(role) {
		forbidden(w, r, httpx.CodeForbidden, "Only the workspace's owners and admins see its audit log.")
		return
	}
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 || limit > 100 {
		badRequest(w, r, "limit must be between 1 and 100.")
		return
	}
	var before pgtype.UUID
	if params.Before != nil {
		before = pgUUID(*params.Before)
	}
	rows, err := h.Queries.ListWorkspaceAudit(r.Context(), store.ListWorkspaceAuditParams{
		WorkspaceID: pgUUID(workspaceID), Before: before, RowLimit: int32(limit + 1), //nolint:gosec // 2..101
		ActionPrefix: deref1(params.Prefix),
	})
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
		ev := api.AuditEvent{
			Id: uuid(e.ID), At: e.At, Action: e.Action, TargetType: e.TargetType, TargetId: e.TargetID,
			Detail: map[string]any{},
		}
		_ = json.Unmarshal(e.Detail, &ev.Detail)
		if e.ActorID.Valid {
			ev.Actor = &struct {
				DisplayName string             `json:"display_name"`
				Id          openapi_types.UUID `json:"id"`
			}{DisplayName: e.ActorName, Id: uuid(e.ActorID)}
		}
		out = append(out, ev)
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Events  []api.AuditEvent `json:"events"`
		HasMore bool             `json:"has_more"`
	}{out, more})
}
