// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/audit"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Data subject requests (GDPR, KVKK): a person's data as one file, and
// erasure that leaves what a legal hold keeps.

// ErasedName is the name an erased account shows.
const ErasedName = "Deleted user"

// exportItem is one line of a data export.
type exportItem struct {
	Kind string `json:"kind"`
	Data any    `json:"data"`
}

// writeUserData streams what the chat stores about a person as NDJSON (their
// Cenacle ID account has its own export).
func (h *Handlers) writeUserData(ctx context.Context, w http.ResponseWriter, u store.User) error {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="cenacle-data.ndjson"`)
	w.Header().Set("Cache-Control", "no-store")
	out := bufio.NewWriter(w)
	enc := json.NewEncoder(out)
	put := func(kind string, data any) error { return enc.Encode(exportItem{kind, data}) }

	username := ""
	if u.Username.Valid {
		username = u.Username.String
	}
	if err := put("profile", map[string]any{
		"id": uuid(u.ID).String(), "display_name": u.DisplayName, "email": u.Email, "username": username,
		"time_zone": u.Timezone, "status_emoji": u.StatusEmoji, "status_text": u.StatusText,
		"out_of_office_from": timeOf(u.OooFrom), "out_of_office_until": timeOf(u.OooUntil),
		"out_of_office_message": u.OooMessage,
		"created_at":            u.CreatedAt, "last_login_at": timeOf(u.LastLoginAt), "last_seen_at": timeOf(u.LastSeenAt),
		"deactivated_at": timeOf(u.DeactivatedAt), "is_admin": u.IsAdmin, "guest": u.DirectoryRole.String == WorkspaceGuest,
	}); err != nil {
		return err
	}
	if c, err := h.Queries.GetAIConsent(ctx, u.ID); err == nil {
		if err := put("ai_consent", map[string]any{"accepted": c.Accepted, "model": c.Model, "decided_at": c.DecidedAt}); err != nil {
			return err
		}
	} else if !isNoRows(err) {
		return err
	}
	workspaces, err := h.Queries.UserWorkspaces(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, ws := range workspaces {
		if err := put("workspace", map[string]any{"id": uuid(ws.ID).String(), "name": ws.Name, "role": ws.Role}); err != nil {
			return err
		}
	}
	channels, err := h.Queries.UserChannels(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, c := range channels {
		if err := put("channel", map[string]any{"id": uuid(c.ID).String(), "name": c.Name, "kind": c.Kind,
			"workspace_id": uuid(c.WorkspaceID).String(), "role": c.Role}); err != nil {
			return err
		}
	}
	var after pgtype.UUID
	for {
		rows, err := h.Queries.UserMessagesAfter(ctx, store.UserMessagesAfterParams{AuthorID: u.ID, After: after, RowLimit: exportPage})
		if err != nil {
			return err
		}
		for _, m := range rows {
			line := map[string]any{"id": uuid(m.ID).String(), "channel_id": uuid(m.ChannelID).String(), "channel_name": m.ChannelName,
				"body": m.Body, "created_at": m.CreatedAt, "edited_at": timeOf(m.EditedAt), "deleted_at": timeOf(m.DeletedAt),
				"has_files": m.HasFiles}
			if m.RootID.Valid {
				line["root_id"] = uuid(m.RootID).String()
			}
			if err := put("message", line); err != nil {
				return err
			}
		}
		if len(rows) < exportPage {
			break
		}
		after = rows[len(rows)-1].ID
		if err := out.Flush(); err != nil {
			return err
		}
	}
	reactions, err := h.Queries.UserReactions(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, r := range reactions {
		if err := put("reaction", map[string]any{"message_id": uuid(r.MessageID).String(), "emoji": r.Emoji, "created_at": r.CreatedAt}); err != nil {
			return err
		}
	}
	files, err := h.Queries.UserFiles(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, f := range files {
		line := map[string]any{"id": uuid(f.ID).String(), "channel_id": uuid(f.ChannelID).String(), "name": f.Name,
			"content_type": f.ContentType, "size": f.Size, "status": f.Status, "created_at": f.CreatedAt}
		if f.MessageID.Valid {
			line["message_id"] = uuid(f.MessageID).String()
		}
		if err := put("file", line); err != nil {
			return err
		}
	}
	sessions, err := h.Queries.UserSessionsAll(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, s := range sessions {
		if err := put("session", map[string]any{"created_at": s.CreatedAt, "last_seen_at": s.LastSeenAt,
			"user_agent": s.UserAgent, "ip_address": s.IpAddress}); err != nil {
			return err
		}
	}
	events, err := h.Queries.UserAuditEvents(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, e := range events {
		detail := map[string]any{}
		_ = json.Unmarshal(e.Detail, &detail)
		line := map[string]any{"at": e.At, "action": e.Action, "target_type": e.TargetType, "target_id": e.TargetID,
			"ip_address": e.IpAddress, "detail": detail}
		if e.WorkspaceID.Valid {
			line["workspace_id"] = uuid(e.WorkspaceID).String()
		}
		if err := put("audit", line); err != nil {
			return err
		}
	}
	rest, err := h.Queries.UserExportRows(ctx, u.ID)
	if err != nil {
		return err
	}
	for _, row := range rest {
		if err := put(row.Kind, json.RawMessage(row.Data)); err != nil {
			return err
		}
	}
	if err := h.writeUserFiles(ctx, out, put, u.ID); err != nil {
		return err
	}
	if err := h.writeUserCalls(ctx, put, u.ID); err != nil {
		return err
	}
	return out.Flush()
}

// exportChunk is how much of a file one export line carries.
const exportChunk = 1 << 20

// writeUserFiles adds the bytes of the files a person uploaded, in base64 lines
// of at most a mebibyte each (file_id, offset).
func (h *Handlers) writeUserFiles(ctx context.Context, out *bufio.Writer, put func(string, any) error, user pgtype.UUID) error {
	if h.Files == nil || h.Files.Store == nil {
		return nil
	}
	files, err := h.Queries.UserFileKeys(ctx, user)
	if err != nil {
		return err
	}
	buf := make([]byte, exportChunk)
	for _, f := range files {
		obj, err := h.Files.Store.Open(ctx, fileKey(f.ID))
		if err != nil {
			// A file whose object is gone says so instead of ending the export.
			if err := put("file_content", map[string]any{"file_id": uuid(f.ID).String(), "missing": true}); err != nil {
				return err
			}
			continue
		}
		var offset int64
		for {
			n, rerr := io.ReadFull(obj, buf)
			if n > 0 {
				if err := put("file_content", map[string]any{"file_id": uuid(f.ID).String(), "offset": offset,
					"data_base64": base64.StdEncoding.EncodeToString(buf[:n])}); err != nil {
					_ = obj.Close()
					return err
				}
				offset += int64(n)
				if err := out.Flush(); err != nil {
					_ = obj.Close()
					return err
				}
			}
			if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
				break
			}
			if rerr != nil {
				_ = obj.Close()
				return rerr
			}
		}
		_ = obj.Close()
	}
	return nil
}

func (h *Handlers) adminTarget(w http.ResponseWriter, r *http.Request, userID openapi_types.UUID) (auth.Principal, store.User, bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return p, store.User{}, false
	}
	u, err := h.Queries.GetUser(r.Context(), pgUUID(userID))
	if isNoRows(err) || (err == nil && u.IsBot) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such person."})
		return p, u, false
	}
	if err != nil {
		h.unavailable(w, r, "get user", err)
		return p, u, false
	}
	return p, u, true
}

// ExportUserData implements api.ServerInterface.
func (h *Handlers) ExportUserData(w http.ResponseWriter, r *http.Request, userID openapi_types.UUID) {
	p, u, ok := h.adminTarget(w, r, userID)
	if !ok {
		return
	}
	h.Audit.Record(r.Context(), audit.Event{Actor: p.User.ID, Action: audit.UserDataExported, IP: p.IP,
		TargetType: "user", TargetID: userID.String(), Detail: map[string]any{"by": "admin"}})
	if err := h.writeUserData(r.Context(), w, u); err != nil {
		h.Log.ErrorContext(r.Context(), "export user data", "error", err)
	}
}

// ExportMyData implements api.ServerInterface.
func (h *Handlers) ExportMyData(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if h.Limiter != nil {
		n, wait, err := h.Limiter.Hit(r.Context(), "cenacle:rl:export:"+uuid(p.User.ID).String(), 10*time.Minute)
		if err == nil && n > 3 {
			w.Header().Set("Retry-After", fmt.Sprint(max(1, int(wait.Seconds()))))
			httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusTooManyRequests, Code: httpx.CodeRateLimited,
				Detail: "You downloaded your data a moment ago; try again in a few minutes."})
			return
		}
	}
	h.Audit.Record(r.Context(), audit.Event{Actor: p.User.ID, Action: audit.UserDataExported, IP: p.IP,
		TargetType: "user", TargetID: uuid(p.User.ID).String(), Detail: map[string]any{"by": "self"}})
	if err := h.writeUserData(r.Context(), w, p.User); err != nil {
		h.Log.ErrorContext(r.Context(), "export my data", "error", err)
	}
}

// EraseUser implements api.ServerInterface.
// auditNeutralDetail are the parts of an audit event's detail that say nothing
// about the person who did it; erasure keeps them and drops the rest (names,
// addresses and whatever later events add).
var auditNeutralDetail = []string{
	"by", "channel", "enabled", "ended", "kept_current", "key_id", "kind", "link",
	"messages_erased", "messages_held", "mode", "prefix", "servers", "sid", "since", "until",
}

func (h *Handlers) EraseUser(w http.ResponseWriter, r *http.Request, userID openapi_types.UUID) {
	var in api.EraseUserJSONBody
	if !decode(w, r, &in) {
		return
	}
	p, u, ok := h.adminTarget(w, r, userID)
	if !ok {
		return
	}
	switch {
	case u.ID == p.User.ID:
		forbidden(w, r, httpx.CodeForbidden, "You cannot erase yourself; ask another administrator.")
		return
	case u.AuthService == "erased":
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "already_erased", Detail: "This person was erased already."})
		return
	case strings.TrimSpace(in.Confirm) != u.DisplayName:
		badRequest(w, r, "Type the person's name to confirm.")
		return
	}
	var counts store.EraseUserMessagesRow
	err := h.inTx(r.Context(), func(q *store.Queries) error {
		avatar, err := q.LockUserAvatar(r.Context(), u.ID)
		if err != nil {
			return err
		}
		if counts, err = q.EraseUserMessages(r.Context(), store.EraseUserMessagesParams{UserID: u.ID, ErasedBy: p.User.ID}); err != nil {
			return err
		}
		if err := eraseUserCalls(r.Context(), q, u.ID); err != nil {
			return err
		}
		// Copies on their way to bots and other servers go too.
		if _, err := q.EraseUserDeliveries(r.Context(), u.ID); err != nil {
			return err
		}
		// Open apps, bots and other servers take the messages away.
		if _, err := q.EmitErasedMessages(r.Context(), u.ID); err != nil {
			return err
		}
		if err := q.EraseUserTraces(r.Context(), u.ID); err != nil {
			return err
		}
		if _, err := q.EraseUserAuditEvents(r.Context(), store.EraseUserAuditEventsParams{UserID: u.ID, Neutral: auditNeutralDetail}); err != nil {
			return err
		}
		// Daily archive objects with their name, address and messages are written again.
		if err := q.MarkArchiveStaleForAuthor(r.Context(), u.ID); err != nil {
			return err
		}
		if _, err = q.EraseUser(r.Context(), store.EraseUserParams{ID: u.ID, DisplayName: ErasedName}); err != nil {
			return err
		}
		if avatar.Valid {
			_, err = q.DeletePictureIfUnused(r.Context(), avatar)
		}
		return err
	})
	if err != nil {
		h.unavailable(w, r, "erase user", err)
		return
	}
	// Who it was stays out of the log: only the id and the counts.
	h.Audit.Record(r.Context(), audit.Event{Actor: p.User.ID, Action: audit.UserErased, IP: p.IP,
		TargetType: "user", TargetID: userID.String(),
		Detail: map[string]any{"messages_erased": counts.Erased, "messages_held": counts.Held}})
	h.userUpdated(r.Context(), u.ID)
	httpx.WriteJSON(w, http.StatusOK, map[string]int32{"messages_erased": counts.Erased, "messages_held": counts.Held})
}
