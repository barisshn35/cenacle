// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"archive/zip"
	"bufio"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Archive exports: a workspace's messages in formats archiving systems
// ingest. These are archives, not chat products: no bridge, one direction.

const archivePage = 500

// CodeArchiveRewriting: a daily export is being written again after a removal.
const CodeArchiveRewriting = "archive_rewriting"

var archiveTypes = map[string]struct{ contentType, ext string }{
	"csv":      {"text/csv; charset=utf-8", "csv"},
	"actiance": {"application/xml", "xml"},
	"eml":      {"application/zip", "zip"},
}

// archiveWriter writes messages in one format.
type archiveWriter interface {
	write(m store.ArchiveMessagesRow) error
	close() error
}

func newArchiveWriter(format string, w io.Writer, host string) archiveWriter {
	switch format {
	case "actiance":
		return newActianceWriter(w)
	case "eml":
		return &emlWriter{zip: zip.NewWriter(w), host: host}
	}
	c := csv.NewWriter(w)
	_ = c.Write([]string{"message_id", "sent_at", "channel_id", "channel_name", "channel_type", "author_id",
		"author_name", "author_email", "thread_root_id", "body", "edited_at", "deleted_at", "files"})
	return &csvWriter{c}
}

func rfc3339(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return t.Time.UTC().Format(time.RFC3339)
}

// writeArchive writes the workspace's messages of [since, until) and counts them.
func writeArchive(ctx context.Context, q store.Querier, w io.Writer, format string, ws pgtype.UUID, since, until time.Time, host string) (int, error) {
	aw := newArchiveWriter(format, w, host)
	n := 0
	arg := store.ArchiveMessagesParams{WorkspaceID: ws, Since: since, Until: until, RowLimit: archivePage}
	for {
		rows, err := q.ArchiveMessages(ctx, arg)
		if err != nil {
			return n, err
		}
		for _, m := range rows {
			if err := aw.write(m); err != nil {
				return n, err
			}
			n++
		}
		if len(rows) < archivePage {
			break
		}
		arg.After = rows[len(rows)-1].ID
	}
	return n, aw.close()
}

type csvWriter struct{ c *csv.Writer }

func (c *csvWriter) write(m store.ArchiveMessagesRow) error {
	root := ""
	if m.RootID.Valid {
		root = uuid(m.RootID).String()
	}
	return c.c.Write([]string{uuid(m.ID).String(), m.CreatedAt.UTC().Format(time.RFC3339), uuid(m.ChannelID).String(),
		m.ChannelName, m.ChannelKind, uuid(m.AuthorID).String(), m.AuthorName, m.AuthorEmail, root, m.Body,
		rfc3339(m.EditedAt), rfc3339(m.DeletedAt), strings.Join(m.FileNames, "; ")})
}

func (c *csvWriter) close() error {
	c.c.Flush()
	return c.c.Error()
}

// Actiance XML (as Vantage and Smarsh ingest): one Conversation per channel,
// opened at its first message; times are Unix milliseconds.
type actianceWriter struct {
	enc     *xml.Encoder
	channel pgtype.UUID
	seen    map[pgtype.UUID]bool
	last    time.Time
	err     error
}

func newActianceWriter(w io.Writer) *actianceWriter {
	_, _ = io.WriteString(w, xml.Header)
	a := &actianceWriter{enc: xml.NewEncoder(w)}
	a.err = a.enc.EncodeToken(xml.StartElement{Name: xml.Name{Local: "FileDump"},
		Attr: []xml.Attr{{Name: xml.Name{Local: "xmlns:xsi"}, Value: "http://www.w3.org/2001/XMLSchema-instance"}}})
	return a
}

func millis(t time.Time) string { return fmt.Sprint(t.UnixMilli()) }

func (a *actianceWriter) element(name string, value string) {
	if a.err == nil {
		a.err = a.enc.EncodeElement(value, xml.StartElement{Name: xml.Name{Local: name}})
	}
}

func (a *actianceWriter) start(name string) {
	if a.err == nil {
		a.err = a.enc.EncodeToken(xml.StartElement{Name: xml.Name{Local: name}})
	}
}

func (a *actianceWriter) end(name string) {
	if a.err == nil {
		a.err = a.enc.EncodeToken(xml.EndElement{Name: xml.Name{Local: name}})
	}
}

func (a *actianceWriter) endConversation() {
	if a.channel.Valid {
		a.element("EndTimeUTC", millis(a.last))
		a.end("Conversation")
	}
}

// Messages come in id order (by time); a channel's Conversation closes when
// another channel's message comes, and a later one opens it again.
func (a *actianceWriter) write(m store.ArchiveMessagesRow) error {
	if m.ChannelID != a.channel {
		a.endConversation()
		a.channel, a.seen = m.ChannelID, map[pgtype.UUID]bool{}
		if a.err == nil {
			a.err = a.enc.EncodeToken(xml.StartElement{Name: xml.Name{Local: "Conversation"},
				Attr: []xml.Attr{{Name: xml.Name{Local: "Perspective"}, Value: m.ChannelName}}})
		}
		a.element("RoomID", uuid(m.ChannelID).String())
		a.element("StartTimeUTC", millis(m.CreatedAt))
	}
	login := m.AuthorEmail
	if login == "" {
		login = uuid(m.AuthorID).String()
	}
	if !a.seen[m.AuthorID] {
		a.seen[m.AuthorID] = true
		a.start("ParticipantEntered")
		a.element("LoginName", login)
		a.element("DateTimeUTC", millis(m.CreatedAt))
		a.element("CorporateEmailID", m.AuthorEmail)
		a.end("ParticipantEntered")
	}
	a.start("Message")
	a.element("LoginName", login)
	a.element("UserType", "user")
	a.element("DateTimeUTC", millis(m.CreatedAt))
	a.element("Content", m.Body)
	a.element("PreviewsPost", "")
	a.end("Message")
	for _, f := range m.FileNames {
		a.start("FileTransferStarted")
		a.element("LoginName", login)
		a.element("DateTimeUTC", millis(m.CreatedAt))
		a.element("UserFileName", f)
		a.end("FileTransferStarted")
	}
	a.last = m.CreatedAt
	return a.err
}

func (a *actianceWriter) close() error {
	a.endConversation()
	a.end("FileDump")
	if a.err == nil {
		a.err = a.enc.Flush()
	}
	return a.err
}

// EML: one RFC 5322 message per chat message, in a ZIP.
type emlWriter struct {
	zip  *zip.Writer
	host string
}

func (e *emlWriter) write(m store.ArchiveMessagesRow) error {
	f, err := e.zip.Create(fmt.Sprintf("%s/%s.eml", safeName(m.ChannelName), uuid(m.ID).String()))
	if err != nil {
		return err
	}
	from := m.AuthorEmail
	if from == "" {
		from = uuid(m.AuthorID).String() + "@" + e.host
	}
	w := bufio.NewWriter(f)
	header := func(k, v string) { _, _ = fmt.Fprintf(w, "%s: %s\r\n", k, v) }
	header("From", mime.QEncoding.Encode("utf-8", m.AuthorName)+" <"+from+">")
	header("To", mime.QEncoding.Encode("utf-8", "#"+m.ChannelName)+" <"+uuid(m.ChannelID).String()+"@"+e.host+">")
	header("Date", m.CreatedAt.UTC().Format(time.RFC1123Z))
	header("Subject", mime.QEncoding.Encode("utf-8", "#"+m.ChannelName))
	header("Message-ID", "<"+uuid(m.ID).String()+"@"+e.host+">")
	if m.RootID.Valid {
		header("In-Reply-To", "<"+uuid(m.RootID).String()+"@"+e.host+">")
	}
	header("X-Cenacle-Channel", uuid(m.ChannelID).String())
	header("X-Cenacle-Channel-Type", m.ChannelKind)
	if m.EditedAt.Valid {
		header("X-Cenacle-Edited", rfc3339(m.EditedAt))
	}
	if m.DeletedAt.Valid {
		header("X-Cenacle-Deleted", rfc3339(m.DeletedAt))
	}
	if len(m.FileNames) > 0 {
		header("X-Cenacle-Files", mime.QEncoding.Encode("utf-8", strings.Join(m.FileNames, "; ")))
	}
	header("MIME-Version", "1.0")
	header("Content-Type", "text/plain; charset=utf-8")
	header("Content-Transfer-Encoding", "base64")
	_, _ = w.WriteString("\r\n")
	enc := base64.StdEncoding.EncodeToString([]byte(m.Body))
	for len(enc) > 76 {
		_, _ = w.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	_, _ = w.WriteString(enc + "\r\n")
	return w.Flush()
}

func (e *emlWriter) close() error { return e.zip.Close() }

// safeName is a channel name usable as a folder in the ZIP.
func safeName(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r < 32 {
			return '_'
		}
		return r
	}, s)
	if s == "" || s == "." || s == ".." {
		return "_"
	}
	return s
}

// ExportArchive implements api.ServerInterface.
func (h *Handlers) ExportArchive(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, params api.ExportArchiveParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceOwner(w, r, workspaceID, p.User, "Only the workspace's owners export its archive.") {
		return
	}
	kind, known := archiveTypes[string(params.Format)]
	switch {
	case !known:
		badRequest(w, r, "format is csv, actiance or eml.")
		return
	case !params.Since.Before(params.Until) || params.Until.Sub(params.Since) > 366*24*time.Hour:
		badRequest(w, r, "since comes before until, at most a year apart.")
		return
	}
	h.record(r, pgUUID(workspaceID), audit.ArchiveExported, "workspace", workspaceID.String(), map[string]any{
		"format": params.Format, "since": params.Since, "until": params.Until})
	w.Header().Set("Content-Type", kind.contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="cenacle-archive.%s"`, kind.ext))
	w.Header().Set("Cache-Control", "no-store")
	if _, err := writeArchive(r.Context(), h.Queries, w, string(params.Format), pgUUID(workspaceID), params.Since, params.Until, serverHost(h.PublicURL)); err != nil {
		h.Log.ErrorContext(r.Context(), "export archive", slog.Any("error", err))
	}
}

func (h *Handlers) archiveSchedule(w http.ResponseWriter, r *http.Request, ws store.Workspace) {
	rows, err := h.Queries.ListArchiveExports(r.Context(), ws.ID)
	if err != nil {
		h.unavailable(w, r, "list archive exports", err)
		return
	}
	format := ws.ArchiveFormat
	if format == "" {
		format = "off"
	}
	out := api.ArchiveSchedule{Format: api.ArchiveScheduleFormat(format), Available: h.Files != nil && h.Files.Store != nil}
	out.Exports = make([]struct {
		CreatedAt time.Time          `json:"created_at"`
		Day       openapi_types.Date `json:"day"`
		Format    api.ArchiveFormat  `json:"format"`
		Id        openapi_types.UUID `json:"id"`
		Messages  int                `json:"messages"`
		Size      int64              `json:"size"`
	}, 0, len(rows))
	for _, e := range rows {
		out.Exports = append(out.Exports, struct {
			CreatedAt time.Time          `json:"created_at"`
			Day       openapi_types.Date `json:"day"`
			Format    api.ArchiveFormat  `json:"format"`
			Id        openapi_types.UUID `json:"id"`
			Messages  int                `json:"messages"`
			Size      int64              `json:"size"`
		}{e.CreatedAt, openapi_types.Date{Time: e.Day.Time}, api.ArchiveFormat(e.Format), uuid(e.ID), int(e.Messages), e.Size})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handlers) ownedWorkspace(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID, detail string) (store.Workspace, bool) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.requireWorkspaceOwner(w, r, workspaceID, p.User, detail) {
		return store.Workspace{}, false
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), pgUUID(workspaceID))
	if err != nil {
		h.unavailable(w, r, "get workspace", err)
		return ws, false
	}
	return ws, true
}

// GetArchiveSchedule implements api.ServerInterface.
func (h *Handlers) GetArchiveSchedule(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	if ws, ok := h.ownedWorkspace(w, r, workspaceID, "Only the workspace's owners see its archive exports."); ok {
		h.archiveSchedule(w, r, ws)
	}
}

// SetArchiveSchedule implements api.ServerInterface.
func (h *Handlers) SetArchiveSchedule(w http.ResponseWriter, r *http.Request, workspaceID openapi_types.UUID) {
	var in api.SetArchiveScheduleJSONBody
	if !decode(w, r, &in) {
		return
	}
	ws, ok := h.ownedWorkspace(w, r, workspaceID, "Only the workspace's owners schedule its archive exports.")
	if !ok {
		return
	}
	format := string(in.Format)
	if format == "off" {
		format = ""
	} else if _, known := archiveTypes[format]; !known {
		badRequest(w, r, "format is off, csv, actiance or eml.")
		return
	} else if h.Files == nil || h.Files.Store == nil {
		badRequest(w, r, "Daily exports need the object store, which this server does not have.")
		return
	}
	if err := h.Queries.SetArchiveFormat(r.Context(), store.SetArchiveFormatParams{ID: ws.ID, Format: format}); err != nil {
		h.unavailable(w, r, "set archive schedule", err)
		return
	}
	h.record(r, ws.ID, audit.ArchiveScheduleChanged, "workspace", workspaceID.String(), map[string]any{"format": in.Format})
	ws.ArchiveFormat = format
	h.archiveSchedule(w, r, ws)
}

// DownloadArchiveExport implements api.ServerInterface.
func (h *Handlers) DownloadArchiveExport(w http.ResponseWriter, r *http.Request, exportID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	e, err := h.Queries.GetArchiveExport(r.Context(), pgUUID(exportID))
	if isNoRows(err) || (err == nil && (h.Files == nil || h.Files.Store == nil)) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No such export."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "get archive export", err)
		return
	}
	if !h.requireWorkspaceOwner(w, r, uuid(e.WorkspaceID), p.User, "Only the workspace's owners download its archive exports.") {
		return
	}
	// Messages of the day were removed since: not served until written again.
	if e.StaleAt.Valid {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeArchiveRewriting,
			Detail: "This day's export is being written again after a removal; try again in a few minutes."})
		return
	}
	obj, err := h.Files.Store.Open(r.Context(), e.ObjectKey)
	if err != nil {
		h.unavailable(w, r, "open archive export", err)
		return
	}
	defer func() { _ = obj.Close() }()
	h.record(r, e.WorkspaceID, audit.ArchiveExported, "archive_export", exportID.String(), map[string]any{"day": e.Day.Time.Format(time.DateOnly)})
	kind := archiveTypes[e.Format]
	w.Header().Set("Content-Type", kind.contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="cenacle-archive-%s.%s"`, e.Day.Time.Format(time.DateOnly), kind.ext))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", e.CreatedAt, obj)
}

// ArchiveExporter writes each whole UTC day of the workspaces with daily
// exports into the object store.
type ArchiveExporter struct {
	Queries *store.Queries
	Files   *Files
	// Host names the messages in EML (the chat's host).
	Host string
	Log  *slog.Logger
}

// Run implements jobs.Runner: up to a week of days per workspace and run.
func (a *ArchiveExporter) Run(ctx context.Context) (int, error) {
	if a.Files == nil || a.Files.Store == nil {
		return 0, nil
	}
	due, err := a.Queries.WorkspacesDueForArchive(ctx)
	if err != nil {
		return 0, err
	}
	done := 0
	yesterday := time.Now().UTC().Truncate(24 * time.Hour).Add(-24 * time.Hour)
	for _, ws := range due {
		day := ws.ArchiveLastDay.Time.UTC().Add(24 * time.Hour)
		for i := 0; i < 7 && !day.After(yesterday); i++ {
			if err := a.exportDay(ctx, ws.ID, ws.ArchiveFormat, day); err != nil {
				a.Log.WarnContext(ctx, "archive export", "workspace", uuid(ws.ID).String(), "day", day.Format(time.DateOnly), "error", err)
				break
			}
			done++
			day = day.Add(24 * time.Hour)
		}
	}
	n, err := a.rewriteStale(ctx)
	return done + n, err
}

// rewriteStale writes again the days whose messages were removed (spillage,
// erasure, retention, burn-on-read) since they were exported, so no copy
// outlives the removal; a day with nothing left loses its export.
func (a *ArchiveExporter) rewriteStale(ctx context.Context) (int, error) {
	stale, err := a.Queries.ListStaleArchiveExports(ctx, 20)
	if err != nil {
		return 0, err
	}
	done := 0
	for _, e := range stale {
		if err := a.rewrite(ctx, e); err != nil {
			a.Log.WarnContext(ctx, "archive rewrite", "export", uuid(e.ID).String(), "error", err)
			continue
		}
		done++
	}
	return done, nil
}

func (a *ArchiveExporter) rewrite(ctx context.Context, e store.ArchiveExport) error {
	tmp, err := os.CreateTemp("", "cenacle-archive-*")
	if err != nil {
		return err
	}
	defer func() { _ = tmp.Close(); _ = os.Remove(tmp.Name()) }()
	day := e.Day.Time.UTC()
	n, err := writeArchive(ctx, a.Queries, tmp, e.Format, e.WorkspaceID, day, day.Add(24*time.Hour), a.Host)
	if err != nil {
		return err
	}
	if n == 0 {
		if _, err := a.Queries.DeleteStaleArchiveExport(ctx, store.DeleteStaleArchiveExportParams{ID: e.ID, StaleAt: e.StaleAt}); err != nil {
			return err
		}
		return a.Files.Store.Remove(ctx, e.ObjectKey)
	}
	size, err := tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := a.Files.Store.Put(ctx, e.ObjectKey, tmp, size, archiveTypes[e.Format].contentType); err != nil {
		return err
	}
	_, err = a.Queries.RewroteArchiveExport(ctx, store.RewroteArchiveExportParams{
		ID: e.ID, StaleAt: e.StaleAt, Size: size, Messages: int32(n), //nolint:gosec // a day's messages
	})
	return err
}

func (a *ArchiveExporter) exportDay(ctx context.Context, ws pgtype.UUID, format string, day time.Time) error {
	tmp, err := os.CreateTemp("", "cenacle-archive-*")
	if err != nil {
		return err
	}
	defer func() { _ = tmp.Close(); _ = os.Remove(tmp.Name()) }()
	n, err := writeArchive(ctx, a.Queries, tmp, format, ws, day, day.Add(24*time.Hour), a.Host)
	if err != nil {
		return err
	}
	size, err := tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	kind := archiveTypes[format]
	key := fmt.Sprintf("archive/%s/%s.%s", uuid(ws).String(), day.Format(time.DateOnly), kind.ext)
	if err := a.Files.Store.Put(ctx, key, tmp, size, kind.contentType); err != nil {
		return err
	}
	d := pgtype.Date{Time: day, Valid: true}
	if _, err := a.Queries.CreateArchiveExport(ctx, store.CreateArchiveExportParams{
		WorkspaceID: ws, Format: format, Day: d, ObjectKey: key, Size: size, Messages: int32(n), //nolint:gosec // a day's messages
	}); err != nil {
		return err
	}
	return a.Queries.SetArchiveLastDay(ctx, store.SetArchiveLastDayParams{ID: ws, Day: d})
}
