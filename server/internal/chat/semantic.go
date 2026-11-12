// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Cenacle-TR/cenacle/server/internal/ai"
	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/auth"
	"github.com/Cenacle-TR/cenacle/server/internal/httpx"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Semantic search (ADR 0055): messages of workspaces with AI on are turned
// into vectors by the operator's embedding model and kept in message_vectors,
// a table whose width is the model's (made here, not by a migration).
// pgvector is in schema public, named in full as the search functions do.

// SemanticDB is what the index needs of the database (a pgxpool.Pool).
type SemanticDB interface {
	Begin(ctx context.Context) (pgx.Tx, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// SemanticIndex keeps the vectors up to date (a periodic job) and finds the
// messages nearest a query.
type SemanticIndex struct {
	DB    SemanticDB
	AI    *ai.Client
	Model string
	Log   *slog.Logger
}

// Limits of the index.
const (
	embedBatch = 32
	// embedRun bounds one run: the rest waits for the next.
	embedRun = 40 * time.Second
	// maxIndexDims is the widest vector an HNSW index of halfvec takes.
	maxIndexDims = 4000
)

// SemanticState says whether semantic search works and, if not, why.
type SemanticState struct {
	// Reason: "" (it works), no_model, no_extension, building, model_error.
	Reason  string
	Model   string
	Indexed int64
	Queued  int64
}

func (s *SemanticIndex) configured() bool { return s != nil && s.AI != nil && s.Model != "" }

func (s *SemanticIndex) extension(ctx context.Context) (bool, error) {
	var ok bool
	err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector' AND n.nspname = 'public')`).Scan(&ok)
	return ok, err
}

type semanticRow struct {
	enabled bool
	model   string
	dims    int
	table   bool
}

func (s *SemanticIndex) state(ctx context.Context) (semanticRow, error) {
	var r semanticRow
	err := s.DB.QueryRow(ctx, `SELECT enabled, model, dims, to_regclass('message_vectors') IS NOT NULL FROM semantic_index`).
		Scan(&r.enabled, &r.model, &r.dims, &r.table)
	return r, err
}

// Ready reports whether searching by meaning works now.
func (s *SemanticIndex) Ready(ctx context.Context) bool {
	if !s.configured() {
		return false
	}
	r, err := s.state(ctx)
	return err == nil && r.enabled && r.table && r.model == s.Model
}

// Status tells the system console how the index is.
func (s *SemanticIndex) Status(ctx context.Context) (SemanticState, error) {
	out := SemanticState{}
	if !s.configured() {
		out.Reason = "no_model"
		return out, nil
	}
	out.Model = s.Model
	ext, err := s.extension(ctx)
	if err != nil {
		return out, err
	}
	if !ext {
		out.Reason = "no_extension"
		return out, nil
	}
	r, err := s.state(ctx)
	if err != nil {
		return out, err
	}
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM embedding_queue`).Scan(&out.Queued); err != nil {
		return out, err
	}
	if !r.enabled || !r.table || r.model != s.Model {
		out.Reason = "building"
		return out, nil
	}
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM message_vectors`).Scan(&out.Indexed); err != nil {
		return out, err
	}
	if out.Queued > 0 && out.Indexed == 0 {
		out.Reason = "building"
	}
	return out, nil
}

// Run brings the index up to date; it returns how many messages it indexed.
func (s *SemanticIndex) Run(ctx context.Context) (int, error) {
	if !s.configured() {
		return 0, s.turnOff(ctx)
	}
	ext, err := s.extension(ctx)
	if err != nil || !ext {
		if err == nil {
			err = s.turnOff(ctx)
		}
		return 0, err
	}
	r, err := s.state(ctx)
	if err != nil {
		return 0, err
	}
	if !r.enabled || !r.table || r.model != s.Model {
		if err := s.rebuild(ctx); err != nil {
			return 0, err
		}
	}
	deadline := time.Now().Add(embedRun)
	done := 0
	for time.Now().Before(deadline) {
		n, more, err := s.batch(ctx)
		done += n
		if err != nil || !more {
			return done, err
		}
	}
	return done, nil
}

// turnOff stops queueing (the vectors stay until the feature is on again).
func (s *SemanticIndex) turnOff(ctx context.Context) error {
	_, err := s.DB.Exec(ctx, `UPDATE semantic_index SET enabled = false WHERE enabled`)
	return err
}

// rebuild makes the vector table for the model (its width asked of the model)
// and queues every message of the workspaces with AI on.
func (s *SemanticIndex) rebuild(ctx context.Context) error {
	probe, err := s.AI.Embed(ctx, s.Model, []string{"dimension"})
	if err != nil {
		return err
	}
	dims := len(probe[0])
	if dims > maxIndexDims {
		return fmt.Errorf("semantic search: the model's vectors are %d wide (at most %d)", dims, maxIndexDims)
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	stmts := []string{
		`SELECT pg_advisory_xact_lock(7419055)`,
		`DROP TABLE IF EXISTS message_vectors`,
		`CREATE TABLE message_vectors (
			message_id   uuid PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
			workspace_id uuid NOT NULL,
			embedding    public.halfvec(` + strconv.Itoa(dims) + `) NOT NULL
		)`,
		`CREATE INDEX message_vectors_workspace ON message_vectors (workspace_id)`,
		`CREATE INDEX message_vectors_near ON message_vectors USING hnsw (embedding public.halfvec_cosine_ops)`,
	}
	for _, q := range stmts {
		if _, err := tx.Exec(ctx, q); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE semantic_index SET enabled = true, model = $1, dims = $2, built_at = now()`, s.Model, dims); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO embedding_queue (message_id)
		SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id JOIN workspaces w ON w.id = c.workspace_id
		WHERE w.ai_enabled AND m.deleted_at IS NULL AND m.burn_seconds IS NULL AND NOT c.encrypted
		ON CONFLICT (message_id) DO NOTHING`); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.Log.InfoContext(ctx, "semantic search: index made", "model", s.Model, "dims", dims)
	return nil
}

// batch indexes the next messages of the queue; more says whether some wait.
func (s *SemanticIndex) batch(ctx context.Context) (int, bool, error) {
	rows, err := s.DB.Query(ctx, `DELETE FROM embedding_queue WHERE message_id IN (
		SELECT message_id FROM embedding_queue ORDER BY queued_at LIMIT $1 FOR UPDATE SKIP LOCKED
	) RETURNING message_id`, embedBatch)
	if err != nil {
		return 0, false, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[pgtype.UUID])
	if err != nil || len(ids) == 0 {
		return 0, false, err
	}
	// What may be indexed: the rest loses its vector (deleted, encrypted,
	// burning, empty, or its workspace turned AI off).
	rows, err = s.DB.Query(ctx, `SELECT m.id, c.workspace_id, m.body FROM messages m
		JOIN channels c ON c.id = m.channel_id JOIN workspaces w ON w.id = c.workspace_id
		WHERE m.id = ANY($1) AND w.ai_enabled AND m.deleted_at IS NULL AND m.burn_seconds IS NULL
		  AND NOT c.encrypted AND btrim(m.body) <> ''`, ids)
	if err != nil {
		return 0, false, err
	}
	type item struct {
		id, ws pgtype.UUID
		body   string
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (item, error) {
		var it item
		return it, r.Scan(&it.id, &it.ws, &it.body)
	})
	if err != nil {
		return 0, false, err
	}
	keep := make([]pgtype.UUID, 0, len(items))
	texts := make([]string, 0, len(items))
	for _, it := range items {
		keep = append(keep, it.id)
		texts = append(texts, it.body)
	}
	if _, err := s.DB.Exec(ctx, `DELETE FROM message_vectors WHERE message_id = ANY($1) AND NOT (message_id = ANY($2))`, ids, keep); err != nil {
		return 0, false, err
	}
	if len(items) > 0 {
		vectors, err := s.AI.Embed(ctx, s.Model, texts)
		if err != nil {
			// Back in the queue for the next run.
			_, _ = s.DB.Exec(context.WithoutCancel(ctx), `INSERT INTO embedding_queue (message_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`, keep)
			return 0, false, err
		}
		batch := &pgx.Batch{}
		for i, it := range items {
			batch.Queue(`INSERT INTO message_vectors (message_id, workspace_id, embedding) VALUES ($1, $2, $3::public.halfvec)
				ON CONFLICT (message_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, embedding = EXCLUDED.embedding`,
				it.id, it.ws, vectorText(vectors[i]))
		}
		tx, err := s.DB.Begin(ctx)
		if err != nil {
			return 0, false, err
		}
		err = tx.SendBatch(ctx, batch).Close()
		if err == nil {
			err = tx.Commit(ctx)
		}
		_ = tx.Rollback(ctx)
		if err != nil {
			return 0, false, err
		}
	}
	return len(items), len(ids) == embedBatch, nil
}

// vectorText writes a vector as pgvector reads it ("[0.1,0.2]").
func vectorText(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 8)
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(x), 'g', 6, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// WorkspaceAIChanged queues a workspace's messages when its AI is turned on,
// and removes its vectors when turned off.
func (s *SemanticIndex) WorkspaceAIChanged(ctx context.Context, workspace pgtype.UUID, on bool) error {
	if !s.configured() {
		return nil
	}
	r, err := s.state(ctx)
	if err != nil || !r.enabled || !r.table {
		return err
	}
	if !on {
		_, err = s.DB.Exec(ctx, `DELETE FROM message_vectors WHERE workspace_id = $1`, workspace)
		return err
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO embedding_queue (message_id)
		SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
		WHERE c.workspace_id = $1 AND m.deleted_at IS NULL AND m.burn_seconds IS NULL AND NOT c.encrypted
		ON CONFLICT (message_id) DO NOTHING`, workspace)
	return err
}

// NearMessage is a message found by meaning.
type NearMessage struct {
	ID, ChannelID, AuthorID, RootID, WorkspaceID pgtype.UUID
	Body, AuthorName, ChannelName, ChannelKind   string
	AuthorIsBot, HasFiles                        bool
	CreatedAt                                    time.Time
	Distance                                     float64
}

// NearFilter narrows a search by meaning (as the search by words).
type NearFilter struct {
	ChannelID, AuthorID pgtype.UUID
	After, Until        pgtype.Timestamptz
	HasFiles, HasLink   bool
	Limit               int
}

// maxNearDistance drops results that are not close in meaning (cosine
// distance: 0 the same, 1 unrelated).
const maxNearDistance = 0.75

// ErrSemanticOff: searching by meaning does not work now.
var ErrSemanticOff = errors.New("semantic search is off")

// Near finds the messages of a workspace nearest the query in meaning, among
// the channels the user is in.
func (s *SemanticIndex) Near(ctx context.Context, user, workspace pgtype.UUID, query string, f NearFilter) ([]NearMessage, error) {
	if !s.Ready(ctx) {
		return nil, ErrSemanticOff
	}
	v, err := s.AI.Embed(ctx, s.Model, []string{query})
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Filters are applied while the index is walked (pgvector 0.8), so a
	// person who reads few channels still gets enough results.
	for _, q := range []string{`SET LOCAL hnsw.iterative_scan = relaxed_order`, `SET LOCAL hnsw.ef_search = 100`,
		`SET LOCAL statement_timeout = '10s'`} {
		if _, err := tx.Exec(ctx, q); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(ctx, `SELECT m.id, m.channel_id, m.author_id, m.root_id, c.workspace_id, m.body,
			u.display_name, c.name, c.kind, u.is_bot, m.has_files, m.created_at, (v.embedding OPERATOR(public.<=>) $3::public.halfvec)::float8 AS distance
		FROM message_vectors v
		JOIN messages m ON m.id = v.message_id
		JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
		JOIN channels c ON c.id = m.channel_id
		JOIN users u ON u.id = m.author_id
		WHERE v.workspace_id = $2 AND m.deleted_at IS NULL AND m.burn_seconds IS NULL AND NOT c.encrypted
		  AND ($4::uuid IS NULL OR m.channel_id = $4)
		  AND ($5::uuid IS NULL OR m.author_id = $5)
		  AND ($6::timestamptz IS NULL OR m.created_at >= $6)
		  AND ($7::timestamptz IS NULL OR m.created_at < $7)
		  AND (NOT $8::boolean OR m.has_files)
		  AND (NOT $9::boolean OR m.body ~* 'https?://')
		ORDER BY v.embedding OPERATOR(public.<=>) $3::public.halfvec
		LIMIT $10`,
		user, workspace, vectorText(v[0]), f.ChannelID, f.AuthorID, f.After, f.Until, f.HasFiles, f.HasLink, f.Limit)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (NearMessage, error) {
		var m NearMessage
		return m, r.Scan(&m.ID, &m.ChannelID, &m.AuthorID, &m.RootID, &m.WorkspaceID, &m.Body,
			&m.AuthorName, &m.ChannelName, &m.ChannelKind, &m.AuthorIsBot, &m.HasFiles, &m.CreatedAt, &m.Distance)
	})
	if err != nil {
		return nil, err
	}
	out := found[:0]
	for _, m := range found {
		if m.Distance <= maxNearDistance {
			out = append(out, m)
		}
	}
	return out, nil
}

// CodeSemanticOff: searching by meaning does not work now.
const CodeSemanticOff = "semantic_search_off"

// aiAllowed: AI is on in the workspace and the person accepted the AI notice
// (searching by meaning sends the query to the model's server). Unlike aiFor
// it counts no request: a search is not a written answer.
func (h *Handlers) aiAllowed(w http.ResponseWriter, r *http.Request, workspace pgtype.UUID, user store.User) bool {
	on, err := h.Queries.GetWorkspaceAI(r.Context(), workspace)
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "get workspace ai", err)
		return false
	}
	if !on {
		forbidden(w, r, CodeAIOff, "The workspace has not turned on AI.")
		return false
	}
	c, err := h.Queries.GetAIConsent(r.Context(), user.ID)
	if err != nil && !isNoRows(err) {
		h.unavailable(w, r, "get ai consent", err)
		return false
	}
	if err != nil || !c.Accepted || c.Model != h.AI.Model {
		forbidden(w, r, CodeAIConsent, "Accept the AI notice before using AI.")
		return false
	}
	return true
}

// searchByMeaning answers a search with mode=meaning.
func (h *Handlers) searchByMeaning(w http.ResponseWriter, r *http.Request, user store.User, params api.SearchMessagesParams) {
	query := strings.TrimSpace(params.Q)
	if query == "" || len([]rune(query)) > 200 {
		badRequest(w, r, "Search for 1 to 200 characters.")
		return
	}
	if params.WorkspaceId == nil {
		badRequest(w, r, "Searching by meaning is within one workspace (workspace_id).")
		return
	}
	if !h.Semantic.Ready(r.Context()) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: CodeSemanticOff, Detail: "Searching by meaning is not available."})
		return
	}
	if _, ok := h.workspaceRole(w, r, *params.WorkspaceId, user); !ok || !h.aiAllowed(w, r, pgUUID(*params.WorkspaceId), user) {
		return
	}
	f := NearFilter{
		ChannelID: optUUID((*[16]byte)(params.ChannelId)), AuthorID: optUUID((*[16]byte)(params.From)),
		Limit: int(searchLimit(params.Limit)),
	}
	if params.After != nil {
		f.After = pgtype.Timestamptz{Time: *params.After, Valid: true}
	}
	if params.Until != nil {
		f.Until = pgtype.Timestamptz{Time: *params.Until, Valid: true}
	}
	if params.Has != nil {
		f.HasFiles = *params.Has == api.SearchMessagesParamsHasFile
		f.HasLink = *params.Has == api.SearchMessagesParamsHasLink
	}
	found, err := h.Semantic.Near(r.Context(), user.ID, pgUUID(*params.WorkspaceId), query, f)
	if err != nil {
		h.Log.WarnContext(r.Context(), "semantic search", "error", err)
		status := http.StatusServiceUnavailable
		if errors.Is(err, ai.ErrModel) {
			status = http.StatusBadGateway
		}
		httpx.WriteProblem(w, r, httpx.Problem{Status: status, Code: CodeAIFailed, Detail: "Searching by meaning did not work. Try searching by words."})
		return
	}
	out := make([]api.SearchMessage, 0, len(found))
	for _, m := range found {
		author := api.Author{Id: uuid(m.AuthorID), DisplayName: m.AuthorName}
		if m.AuthorIsBot {
			bot := true
			author.IsBot = &bot
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"results": out, "has_more": false})
}

// GetSemanticSearchStatus implements api.ServerInterface.
func (h *Handlers) GetSemanticSearchStatus(w http.ResponseWriter, r *http.Request) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !requireInstanceAdmin(w, r, p) {
		return
	}
	st, err := h.Semantic.Status(r.Context())
	if err != nil {
		h.unavailable(w, r, "semantic search status", err)
		return
	}
	state := st.Reason
	if state == "" {
		state = "ready"
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"state": state, "model": st.Model, "indexed": st.Indexed, "queued": st.Queued})
}
