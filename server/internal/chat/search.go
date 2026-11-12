// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

const searchPage = 20

// defaultSearchTimeout is the longest a search may run. A slower one is stopped
// and the person is asked to narrow it down, instead of waiting until the server
// gives up on the response (30 s) and getting nothing.
const defaultSearchTimeout = 10 * time.Second

// searching runs fn's queries in a transaction whose statements stop after the
// search timeout. SET LOCAL ends with the transaction, so the limit never stays on
// a pooled connection that other queries use next.
func (h *Handlers) searching(ctx context.Context, fn func(q *store.Queries) error) error {
	limit := h.SearchTimeout
	if limit <= 0 {
		limit = defaultSearchTimeout
	}
	return h.inTx(ctx, func(q *store.Queries) error {
		if err := q.SetSearchTimeout(ctx, strconv.FormatInt(limit.Milliseconds(), 10)); err != nil {
			return err
		}
		return fn(q)
	})
}

// searchFailed answers a failed search: too slow (the statement timeout of
// searching), or the database is unavailable.
func (h *Handlers) searchFailed(w http.ResponseWriter, r *http.Request, msg string, err error) {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "57014" { // query_canceled, here by statement_timeout
		h.Log.WarnContext(r.Context(), msg+": too slow", "request_id", httpx.RequestIDFrom(r.Context()))
		httpx.WriteProblem(w, r, httpx.Problem{
			Status: http.StatusServiceUnavailable, Code: httpx.CodeSearchTimeout,
			Detail: "The search took too long and was stopped; try more specific words or a filter.",
		})
		return
	}
	h.unavailable(w, r, msg, err)
}

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
	if params.Mode != nil && *params.Mode == api.Meaning {
		h.searchByMeaning(w, r, p.User, params)
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
		args.HasFiles = *params.Has == api.SearchMessagesParamsHasFile
		args.HasLink = *params.Has == api.SearchMessagesParamsHasLink
	}
	var rows []store.SearchMessagesRow
	err := h.searching(r.Context(), func(q *store.Queries) (err error) {
		rows, err = q.SearchMessages(r.Context(), args)
		return err
	})
	if err != nil {
		h.searchFailed(w, r, "search messages", err)
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
		res := api.SearchMessage{
			Id: uuid(m.ID), Channel: searchChannel(m.ChannelID, m.WorkspaceID, m.ChannelName, m.ChannelKind),
			Author: author, Body: m.Body, CreatedAt: m.CreatedAt, HasFiles: m.HasFiles,
		}
		if m.RootID.Valid {
			root := uuid(m.RootID)
			res.RootId = &root
		}
		out = append(out, res)
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
	var rows []store.SearchFilesRow
	err := h.searching(r.Context(), func(qs *store.Queries) (err error) {
		rows, err = qs.SearchFiles(r.Context(), store.SearchFilesParams{
			UserID: p.User.ID, Query: q, RowLimit: limit + 1,
			WorkspaceID: optUUID((*[16]byte)(params.WorkspaceId)),
			Before:      optUUID((*[16]byte)(params.Before)),
		})
		return err
	})
	if err != nil {
		h.searchFailed(w, r, "search files", err)
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
			Excerpt:  ptr(excerpt(f.ContentHead, q)),
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"results": out, "has_more": more})
}

// SearchContent implements api.ServerInterface.
func (h *Handlers) SearchContent(w http.ResponseWriter, r *http.Request, params api.SearchContentParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	q, ok := h.searchable(w, r, params.Q)
	if !ok {
		return
	}
	ws := optUUID((*[16]byte)(params.WorkspaceId))
	var canvases []store.SearchCanvasesRow
	var items []store.SearchListItemsRow
	err := h.searching(r.Context(), func(qs *store.Queries) (err error) {
		if canvases, err = qs.SearchCanvases(r.Context(), store.SearchCanvasesParams{UserID: p.User.ID, Query: q, WorkspaceID: ws}); err != nil {
			return err
		}
		items, err = qs.SearchListItems(r.Context(), store.SearchListItemsParams{UserID: p.User.ID, Query: q, WorkspaceID: ws})
		return err
	})
	if err != nil {
		h.searchFailed(w, r, "search canvases and lists", err)
		return
	}
	type canvasHit struct {
		TabID     openapi_types.UUID `json:"tab_id"`
		Title     string             `json:"title"`
		Channel   api.SearchChannel  `json:"channel"`
		Excerpt   string             `json:"excerpt"`
		UpdatedAt time.Time          `json:"updated_at"`
	}
	type itemHit struct {
		ID        openapi_types.UUID `json:"id"`
		Title     string             `json:"title"`
		TabID     openapi_types.UUID `json:"tab_id"`
		ListTitle string             `json:"list_title"`
		Channel   api.SearchChannel  `json:"channel"`
		UpdatedAt time.Time          `json:"updated_at"`
	}
	out := struct {
		Canvases []canvasHit `json:"canvases"`
		Items    []itemHit   `json:"items"`
	}{Canvases: []canvasHit{}, Items: []itemHit{}}
	for _, c := range canvases {
		out.Canvases = append(out.Canvases, canvasHit{uuid(c.TabID), c.Title,
			searchChannel(c.ChannelID, c.WorkspaceID, c.ChannelName, c.ChannelKind), excerpt(c.ContentHead, q), c.UpdatedAt})
	}
	for _, i := range items {
		out.Items = append(out.Items, itemHit{uuid(i.ID), i.ItemTitle, uuid(i.TabID), i.ListTitle,
			searchChannel(i.ChannelID, i.WorkspaceID, i.ChannelName, i.ChannelKind), i.UpdatedAt})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}
