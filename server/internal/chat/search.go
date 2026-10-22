// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

const searchPage = 20

func optUUID(id *[16]byte) pgtype.UUID {
	if id == nil {
		return pgtype.UUID{}
	}
	return pgtype.UUID{Bytes: *id, Valid: true}
}

func searchLimit(limit *int) int32 {
	if limit == nil || *limit < 1 || *limit > 50 {
		return searchPage
	}
	return int32(*limit)
}

// searchable answers 400 unless the query has something to look for.
func (h *Handlers) searchable(w http.ResponseWriter, r *http.Request, q string) (string, bool) {
	q = strings.TrimSpace(q)
	if q == "" || len([]rune(q)) > 200 {
		badRequest(w, r, "Search for 1 to 200 characters.")
		return "", false
	}
	ok, err := h.Queries.SearchQueryValid(r.Context(), q)
	if err != nil {
		h.unavailable(w, r, "search query", err)
		return "", false
	}
	if !ok {
		badRequest(w, r, "The search has no letters or digits to look for.")
		return "", false
	}
	return q, true
}

func searchChannel(id, ws pgtype.UUID, name, kind string) api.SearchChannel {
	return api.SearchChannel{Id: uuid(id), WorkspaceId: uuid(ws), Name: name, Kind: api.SearchChannelKind(kind)}
}

// SearchMessages implements api.ServerInterface.
func (h *Handlers) SearchMessages(w http.ResponseWriter, r *http.Request, params api.SearchMessagesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	q, ok := h.searchable(w, r, params.Q)
	if !ok {
		return
	}
	limit := searchLimit(params.Limit)
	args := store.SearchMessagesParams{
		UserID: p.User.ID, Query: q, RowLimit: limit + 1,
		WorkspaceID: optUUID((*[16]byte)(params.WorkspaceId)),
		ChannelID:   optUUID((*[16]byte)(params.ChannelId)),
		AuthorID:    optUUID((*[16]byte)(params.From)),
		Before:      optUUID((*[16]byte)(params.Before)),
	}
	if params.After != nil {
		args.After = pgtype.Timestamptz{Time: *params.After, Valid: true}
	}
	if params.Until != nil {
		args.Until = pgtype.Timestamptz{Time: *params.Until, Valid: true}
	}
	if params.Has != nil {
		args.HasFiles = *params.Has == api.File
		args.HasLink = *params.Has == api.Link
	}
	rows, err := h.Queries.SearchMessages(r.Context(), args)
	if err != nil {
		h.unavailable(w, r, "search messages", err)
		return
	}
	more := len(rows) > int(limit)
	if more {
		rows = rows[:limit]
	}
	out := make([]api.SearchMessage, 0, len(rows))
	for _, m := range rows {
		author := api.Author{Id: uuid(m.AuthorID), DisplayName: m.AuthorName}
		if m.AuthorIsBot {
			author.IsBot = &m.AuthorIsBot
		}
		out = append(out, api.SearchMessage{
			Id: uuid(m.ID), Channel: searchChannel(m.ChannelID, m.WorkspaceID, m.ChannelName, m.ChannelKind),
			Author: author, Body: m.Body, CreatedAt: m.CreatedAt, HasFiles: m.HasFiles,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"results": out, "has_more": more})
}

// SearchFiles implements api.ServerInterface.
func (h *Handlers) SearchFiles(w http.ResponseWriter, r *http.Request, params api.SearchFilesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	q, ok := h.searchable(w, r, params.Q)
	if !ok {
		return
	}
	limit := searchLimit(params.Limit)
	rows, err := h.Queries.SearchFiles(r.Context(), store.SearchFilesParams{
		UserID: p.User.ID, Query: q, RowLimit: limit + 1,
		WorkspaceID: optUUID((*[16]byte)(params.WorkspaceId)),
		Before:      optUUID((*[16]byte)(params.Before)),
	})
	if err != nil {
		h.unavailable(w, r, "search files", err)
		return
	}
	more := len(rows) > int(limit)
	if more {
		rows = rows[:limit]
	}
	out := make([]api.SearchFile, 0, len(rows))
	for _, f := range rows {
		out = append(out, api.SearchFile{
			Id: uuid(f.ID), Channel: searchChannel(f.ChannelID, f.WorkspaceID, f.ChannelName, f.ChannelKind),
			MessageId: uuid(f.MessageID), Name: f.Name, ContentType: f.ContentType, Size: f.Size,
			HasThumbnail: f.HasThumbnail, CreatedAt: f.CreatedAt,
			Uploader: api.Author{Id: uuid(f.UploaderID), DisplayName: f.UploaderName},
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"results": out, "has_more": more})
}
