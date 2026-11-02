// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/clamav"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/preview"
	"github.com/barisshn35/cenacle/server/internal/storage"
	"github.com/barisshn35/cenacle/server/internal/store"
	"github.com/barisshn35/cenacle/server/internal/telemetry"
)

// Problem codes of files.
const (
	CodeFilesDisabled    = "files_disabled"
	CodeFileTooLarge     = "file_too_large"
	CodeUploadIncomplete = "upload_incomplete"
	CodeFileBlocked      = "file_blocked"
	CodeFilesUnavailable = "files_unavailable"
	CodeTooManyUploads   = "too_many_uploads"
)

const (
	// uploadValid is how long an upload form works.
	uploadValid = 15 * time.Minute
	// MaxFilesPerMessage bounds the files of one message.
	MaxFilesPerMessage = 10
	// maxPreviewSize: larger images are kept without a preview.
	maxPreviewSize = 40 << 20
	filesPage      = 50
	// fileWriteTimeout bounds sending one file (a slow client and a large file).
	fileWriteTimeout = time.Hour
	// MaxUnsentFiles bounds the uploads a person has not sent yet (they take
	// space until sent or removed).
	MaxUnsentFiles = 50
)

// errFilesUnavailable: a message names files that are not the sender's ready,
// unsent uploads into the channel.
var errFilesUnavailable = errors.New("files unavailable")

// ErrIngestTooLarge: a file to ingest is larger than uploads may be.
var ErrIngestTooLarge = errors.New("file larger than this server allows")

// Files are the object store and the checks of uploads.
type Files struct {
	Store   storage.Store
	Scanner *clamav.Scanner // nil: files are not scanned
	MaxSize int64
	// previews bounds concurrent image decoding (memory).
	previews chan struct{}
}

// NewFiles prepares file handling; store nil means files are off.
func NewFiles(store storage.Store, scanner *clamav.Scanner, maxSize int64) *Files {
	return &Files{Store: store, Scanner: scanner, MaxSize: maxSize, previews: make(chan struct{}, 4)}
}

func fileKey(id pgtype.UUID) string  { return "files/" + uuid(id).String() }
func thumbKey(id pgtype.UUID) string { return "thumbs/" + uuid(id).String() }

// uploadKey is where a browser's upload lands on backends that stage uploads.
func uploadKey(id pgtype.UUID) string { return "uploads/" + uuid(id).String() }

// formKey is the key a new upload is sent to.
func (fs *Files) formKey(id pgtype.UUID) string {
	if _, ok := fs.Store.(storage.Staged); ok {
		return uploadKey(id)
	}
	return fileKey(id)
}

func fileAPI(f store.File) api.FileInfo {
	out := api.FileInfo{Id: uuid(f.ID), Name: f.Name, ContentType: f.ContentType, Size: f.Size,
		HasThumbnail: f.HasThumbnail}
	if f.Encrypted {
		out.Encrypted = ptr(true)
	}
	if f.Width.Valid {
		w, h := int(f.Width.Int32), int(f.Height.Int32)
		out.Width, out.Height = &w, &h
	}
	if f.MediaKind.Valid {
		out.MediaKind = ptr(api.FileInfoMediaKind(f.MediaKind.String))
	}
	if f.DurationMs.Valid {
		out.DurationMs = ptr(int(f.DurationMs.Int32))
	}
	if len(f.Waveform) > 0 {
		levels := make([]int, len(f.Waveform))
		for i, b := range f.Waveform {
			levels[i] = int(b)
		}
		out.Waveform = &levels
	}
	return out
}

// mediaFields checks what the app says about a recording: a voice message
// or a clip, its length and (voice) its waveform.
func mediaFields(kind *string, duration *int, waveform []int) (store.CreateFileParams, string) {
	var out store.CreateFileParams
	if kind == nil {
		if duration != nil || len(waveform) > 0 {
			return out, "A length or waveform belongs to a voice message or clip."
		}
		return out, ""
	}
	if *kind != "voice" && *kind != "clip" {
		return out, "media_kind is voice or clip."
	}
	out.MediaKind = pgtype.Text{String: *kind, Valid: true}
	if duration != nil {
		if *duration < 0 || *duration > 3_600_000 {
			return out, "A recording is at most an hour long."
		}
		out.DurationMs = pgtype.Int4{Int32: int32(*duration), Valid: true} //nolint:gosec // bounded above
	}
	if len(waveform) > 64 {
		return out, "A waveform has at most 64 levels."
	}
	if len(waveform) > 0 {
		if *kind != "voice" {
			return out, "Only voice messages have a waveform."
		}
		out.Waveform = make([]byte, len(waveform))
		for i, v := range waveform {
			if v < 0 || v > 255 {
				return out, "Waveform levels are 0 to 255."
			}
			out.Waveform[i] = byte(v)
		}
	}
	return out, ""
}

// cleanFileName keeps the last path element and drops control characters.
func cleanFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '"' {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if !utf8.ValidString(name) {
		return ""
	}
	if r := []rune(name); len(r) > 255 {
		name = string(r[:255])
	}
	return name
}

// cleanContentType keeps a plausible media type, else a generic one.
func cleanContentType(ct string) string {
	t, _, err := mime.ParseMediaType(ct)
	if err != nil || len(t) > 100 || !strings.Contains(t, "/") {
		return "application/octet-stream"
	}
	return strings.ToLower(t)
}

func (h *Handlers) filesOn(w http.ResponseWriter, r *http.Request) bool {
	if h.Files == nil || h.Files.Store == nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: CodeFilesDisabled,
			Detail: "Files are not set up on this server."})
		return false
	}
	return true
}

// CreateUpload implements api.ServerInterface.
func (h *Handlers) CreateUpload(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.filesOn(w, r) {
		return
	}
	var in struct {
		Name        string  `json:"name"`
		Size        int64   `json:"size"`
		ContentType *string `json:"content_type"`
		MediaKind   *string `json:"media_kind"`
		DurationMs  *int    `json:"duration_ms"`
		Waveform    []int   `json:"waveform"`
		Encrypted   bool    `json:"encrypted"`
	}
	if !decode(w, r, &in) {
		return
	}
	media, problem := mediaFields(in.MediaKind, in.DurationMs, in.Waveform)
	if problem != "" {
		badRequest(w, r, problem)
		return
	}
	name := cleanFileName(in.Name)
	switch {
	case name == "":
		badRequest(w, r, "The file needs a name.")
		return
	case in.Size < 1:
		badRequest(w, r, "The file is empty.")
		return
	case in.Size > h.Files.MaxSize:
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusRequestEntityTooLarge, Code: CodeFileTooLarge,
			Detail: "The file is larger than this server allows."})
		return
	}
	contentType := "application/octet-stream"
	if in.ContentType != nil {
		contentType = cleanContentType(*in.ContentType)
	}
	c, role, ok := h.memberChannel(w, r, channelID, p.User)
	if !ok {
		return
	}
	if !canPost(c, role) {
		forbidden(w, r, CodeReadOnlyChannel, "You cannot send messages in this channel.")
		return
	}
	switch {
	case c.Encrypted && !c.Mls, c.Mls && !in.Encrypted:
		// Passphrase channels take no files; MLS channels take files encrypted in the browser.
		refuseEncrypted(w, r)
		return
	case !c.Mls && in.Encrypted:
		badRequest(w, r, "Only files of channels encrypted with device keys are encrypted.")
		return
	case in.Encrypted:
		// The name and type travel inside the encrypted message.
		name, contentType = "encrypted", "application/octet-stream"
		media = store.CreateFileParams{}
	}
	if !h.allowMessage(w, r, p.User) {
		return
	}
	unsent, err := h.Queries.CountUnsentFiles(r.Context(), p.User.ID)
	if err != nil {
		h.unavailable(w, r, "count uploads", err)
		return
	}
	if unsent >= MaxUnsentFiles {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeTooManyUploads,
			Detail: "You have 50 files that are not sent yet; send or remove some first."})
		return
	}
	f, err := h.Queries.CreateFile(r.Context(), store.CreateFileParams{
		WorkspaceID: c.WorkspaceID, ChannelID: c.ID, UploaderID: p.User.ID, Name: name,
		ContentType: contentType, Size: in.Size,
		MediaKind: media.MediaKind, DurationMs: media.DurationMs, Waveform: media.Waveform, Encrypted: in.Encrypted,
	})
	if err != nil {
		h.unavailable(w, r, "create file", err)
		return
	}
	form, err := h.Files.Store.UploadForm(r.Context(), h.Files.formKey(f.ID), f.Size, uploadValid)
	if err != nil {
		h.unavailable(w, r, "upload form", err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, struct {
		File   api.FileInfo   `json:"file"`
		Upload storage.Upload `json:"upload"`
	}{fileAPI(f), form})
}

// ownUpload loads a file the user uploaded, or answers 404.
func (h *Handlers) ownUpload(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.File, bool) {
	f, err := h.Queries.GetFile(r.Context(), pgUUID(id))
	if isNoRows(err) || (err == nil && f.UploaderID != user.ID) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No file with this id."})
		return f, false
	}
	if err != nil {
		h.unavailable(w, r, "get file", err)
		return f, false
	}
	return f, true
}

// CompleteUpload implements api.ServerInterface.
func (h *Handlers) CompleteUpload(w http.ResponseWriter, r *http.Request, fileID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.filesOn(w, r) {
		return
	}
	f, ok := h.ownUpload(w, r, fileID, p.User)
	if !ok {
		return
	}
	switch f.Status {
	case "ready":
		httpx.WriteJSON(w, http.StatusOK, fileAPI(f))
		return
	case "blocked":
		blocked(w, r)
		return
	}
	// One completion at a time: the claimant alone moves the bytes to the
	// file's key, checks them and records the verdict, so a verdict always
	// belongs to the bytes that are served.
	claimed, err := h.Queries.ClaimUpload(r.Context(), store.ClaimUploadParams{ID: f.ID, UploaderID: p.User.ID})
	if isNoRows(err) {
		h.claimedElsewhere(w, r, f.ID)
		return
	}
	if err != nil {
		h.unavailable(w, r, "claim upload", err)
		return
	}
	f = claimed
	finished := false
	defer func() {
		if !finished { // nothing recorded: the upload can be completed again at once
			_ = h.Queries.ReleaseUpload(context.WithoutCancel(r.Context()),
				store.ReleaseUploadParams{ID: f.ID, CheckClaim: f.CheckClaim})
		}
	}()
	// The upload moves to the file's key now; what arrives later under the
	// upload key again is never checked or served.
	if st, ok := h.Files.Store.(storage.Staged); ok {
		if err := st.Promote(r.Context(), uploadKey(f.ID), fileKey(f.ID)); err != nil && !errors.Is(err, storage.ErrNotFound) {
			h.unavailable(w, r, "promote upload", err)
			return
		}
	}
	size, err := h.Files.Store.Size(r.Context(), fileKey(f.ID))
	if errors.Is(err, storage.ErrNotFound) || (err == nil && size != f.Size) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeUploadIncomplete,
			Detail: "The file has not arrived completely; upload it again."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "stat upload", err)
		return
	}
	done, err := h.Files.check(r.Context(), f)
	if err != nil {
		h.unavailable(w, r, "check upload", err)
		return
	}
	updated, err := h.Queries.FinishUpload(r.Context(), done)
	if isNoRows(err) { // the claim ran out and another completion took over
		h.claimedElsewhere(w, r, f.ID)
		return
	}
	if err != nil {
		h.unavailable(w, r, "finish upload", err)
		return
	}
	finished = true
	telemetry.Uploads.WithLabelValues(updated.Status).Inc()
	if updated.Status == "ready" {
		telemetry.UploadBytes.Add(float64(updated.Size))
	}
	if updated.Status == "blocked" {
		h.Log.WarnContext(r.Context(), "upload blocked by the virus scanner", "file", uuid(f.ID).String(),
			"user", uuid(p.User.ID).String())
		blocked(w, r)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, fileAPI(updated))
}

// claimedElsewhere answers a completion that another one is checking or has
// checked: with that one's verdict when there is one.
func (h *Handlers) claimedElsewhere(w http.ResponseWriter, r *http.Request, id pgtype.UUID) {
	f, err := h.Queries.GetFile(r.Context(), id)
	if err != nil {
		h.unavailable(w, r, "get file", err)
		return
	}
	switch f.Status {
	case "ready":
		httpx.WriteJSON(w, http.StatusOK, fileAPI(f))
	case "blocked":
		blocked(w, r)
	default:
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: CodeUploadIncomplete,
			Detail: "The file is being checked; try again in a moment."})
	}
}

func blocked(w http.ResponseWriter, r *http.Request) {
	httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusUnprocessableEntity, Code: CodeFileBlocked,
		Detail: "The virus scanner rejected this file."})
}

// Open reads the bytes of a file.
func (fs *Files) Open(ctx context.Context, f store.File) (storage.Object, error) {
	return fs.Store.Open(ctx, fileKey(f.ID))
}

// Ingest stores the bytes of a file recorded by the server itself (an
// import) and checks them as an upload: scanned, images recognized, previews
// made. A file larger than uploads may be is refused (ErrIngestTooLarge).
func (fs *Files) Ingest(ctx context.Context, q *store.Queries, f store.File, r io.Reader) error {
	if f.Size < 0 || (fs.MaxSize > 0 && f.Size > fs.MaxSize) {
		return ErrIngestTooLarge
	}
	f, err := q.ClaimUpload(ctx, store.ClaimUploadParams{ID: f.ID, UploaderID: f.UploaderID})
	if err != nil {
		return err
	}
	// Never more than the recorded size, whatever the reader holds.
	if err := fs.Store.Put(ctx, fileKey(f.ID), io.LimitReader(r, f.Size), f.Size, f.ContentType); err != nil {
		return err
	}
	done, err := fs.check(ctx, f)
	if err != nil {
		return err
	}
	_, err = q.FinishUpload(ctx, done)
	return err
}

// check scans an uploaded file, recognizes images and makes their preview.
func (fs *Files) check(ctx context.Context, f store.File) (store.FinishUploadParams, error) {
	out := store.FinishUploadParams{ID: f.ID, CheckClaim: f.CheckClaim, Status: "ready", ContentType: f.ContentType}
	if f.Encrypted {
		return out, nil // ciphertext: nothing to scan, recognize or preview
	}
	if fs.Scanner != nil {
		obj, err := fs.Store.Open(ctx, fileKey(f.ID))
		if err != nil {
			return out, err
		}
		res, err := fs.Scanner.Scan(ctx, obj)
		_ = obj.Close()
		if err != nil {
			return out, err
		}
		if !res.Clean {
			out.Status = "blocked"
			return out, fs.Store.Remove(ctx, fileKey(f.ID))
		}
	}
	obj, err := fs.Store.Open(ctx, fileKey(f.ID))
	if err != nil {
		return out, err
	}
	defer func() { _ = obj.Close() }()
	head := make([]byte, 512)
	n, err := io.ReadFull(obj, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return out, err
	}
	sniffed := preview.Sniff(head[:n])
	switch {
	case preview.Images[sniffed]:
		out.ContentType = sniffed
	case strings.HasPrefix(f.ContentType, "image/") || strings.HasPrefix(f.ContentType, "text/html"):
		// Claimed an image (or a page) it is not: never show it as one.
		out.ContentType = "application/octet-stream"
	}
	if !preview.Images[out.ContentType] || f.Size > maxPreviewSize {
		return out, nil
	}
	fs.previews <- struct{}{}
	defer func() { <-fs.previews }()
	if _, err := obj.Seek(0, io.SeekStart); err != nil {
		return out, err
	}
	data, err := io.ReadAll(io.LimitReader(obj, maxPreviewSize))
	if err != nil {
		return out, err
	}
	res, err := preview.Make(ctx, data, out.ContentType)
	if err != nil {
		return out, nil // a broken or huge image is kept, without a preview
	}
	out.Width = pgtype.Int4{Int32: int32(res.Width), Valid: true}   //nolint:gosec // bounded by MaxPixels
	out.Height = pgtype.Int4{Int32: int32(res.Height), Valid: true} //nolint:gosec // bounded by MaxPixels
	if err := fs.Store.Put(ctx, thumbKey(f.ID), bytes.NewReader(res.Thumb), int64(len(res.Thumb)), res.ThumbType); err != nil {
		return out, err
	}
	out.HasThumbnail = true
	return out, nil
}

// DeleteUpload implements api.ServerInterface.
func (h *Handlers) DeleteUpload(w http.ResponseWriter, r *http.Request, fileID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.filesOn(w, r) {
		return
	}
	f, err := h.Queries.DeleteUnattachedFile(r.Context(), store.DeleteUnattachedFileParams{ID: pgUUID(fileID), UploaderID: p.User.ID})
	if isNoRows(err) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound,
			Detail: "No unsent file with this id."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "delete file", err)
		return
	}
	h.Files.remove(r.Context(), f)
	w.WriteHeader(http.StatusNoContent)
}

func (fs *Files) remove(ctx context.Context, f store.File) {
	_ = fs.Store.Remove(ctx, fileKey(f.ID))
	if _, ok := fs.Store.(storage.Staged); ok {
		_ = fs.Store.Remove(ctx, uploadKey(f.ID))
	}
	if f.HasThumbnail {
		_ = fs.Store.Remove(ctx, thumbKey(f.ID))
	}
}

// readableFile loads a ready file the user may see: one in a visible message
// of a channel they are a member of, or their own unsent upload.
func (h *Handlers) readableFile(w http.ResponseWriter, r *http.Request, id openapi_types.UUID, user store.User) (store.File, bool) {
	notFound := func() {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "No file with this id."})
	}
	row, err := h.Queries.GetFileForReader(r.Context(), pgUUID(id))
	if isNoRows(err) {
		notFound()
		return store.File{}, false
	}
	if err != nil {
		h.unavailable(w, r, "get file", err)
		return store.File{}, false
	}
	f := store.File{ID: row.ID, WorkspaceID: row.WorkspaceID, ChannelID: row.ChannelID, UploaderID: row.UploaderID,
		MessageID: row.MessageID, Name: row.Name, ContentType: row.ContentType, Size: row.Size, Status: row.Status,
		Width: row.Width, Height: row.Height, HasThumbnail: row.HasThumbnail, CreatedAt: row.CreatedAt}
	if f.Status != "ready" || row.MessageDeleted || (!f.MessageID.Valid && f.UploaderID != user.ID) {
		notFound()
		return f, false
	}
	if f.MessageID.Valid {
		if _, _, ok := h.memberChannel(w, r, uuid(f.ChannelID), user); !ok {
			return f, false
		}
	}
	return f, true
}

// inlineTypes are shown in the browser; everything else is downloaded.
var inlineTypes = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true,
	"video/mp4": true, "video/webm": true, "audio/mpeg": true, "audio/ogg": true, "audio/wav": true,
	"audio/webm": true, "audio/mp4": true, "application/pdf": true,
}

// serveObject sends a stored object with headers that keep it from acting as
// a page of the app (it is served from the app's origin).
func (h *Handlers) serveObject(w http.ResponseWriter, r *http.Request, key, name, contentType string, modified time.Time, download bool) {
	obj, err := h.Files.Store.Open(r.Context(), key)
	if errors.Is(err, storage.ErrNotFound) {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The file is gone."})
		return
	}
	if err != nil {
		h.unavailable(w, r, "open file", err)
		return
	}
	defer func() { _ = obj.Close() }()
	disposition := "inline"
	if download || !inlineTypes[contentType] {
		disposition = "attachment"
		if !inlineTypes[contentType] {
			contentType = "application/octet-stream"
		}
	}
	hd := w.Header()
	hd.Set("Content-Type", contentType)
	hd.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": name}))
	hd.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'")
	hd.Set("Cross-Origin-Resource-Policy", "same-origin")
	// Access ends (signing out, deletion, spillage): a cached copy is used
	// only after the server has checked access again (a cheap 304).
	hd.Set("Cache-Control", "private, no-cache")
	// Large files take longer than the server's usual write timeout.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(fileWriteTimeout))
	http.ServeContent(w, r, "", modified, obj)
}

// GetFileContent implements api.ServerInterface.
func (h *Handlers) GetFileContent(w http.ResponseWriter, r *http.Request, fileID openapi_types.UUID, params api.GetFileContentParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.filesOn(w, r) {
		return
	}
	f, ok := h.readableFile(w, r, fileID, p.User)
	if !ok {
		return
	}
	h.serveObject(w, r, fileKey(f.ID), f.Name, f.ContentType, f.CreatedAt, params.Download != nil && *params.Download)
}

// GetFileThumbnail implements api.ServerInterface.
func (h *Handlers) GetFileThumbnail(w http.ResponseWriter, r *http.Request, fileID openapi_types.UUID) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok || !h.filesOn(w, r) {
		return
	}
	f, ok := h.readableFile(w, r, fileID, p.User)
	if !ok {
		return
	}
	if !f.HasThumbnail {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusNotFound, Code: httpx.CodeNotFound, Detail: "The file has no preview."})
		return
	}
	// Previews are JPEG unless the image has transparency.
	contentType := "image/jpeg"
	if f.ContentType == "image/png" || f.ContentType == "image/gif" || f.ContentType == "image/webp" {
		contentType = h.Files.thumbType(r.Context(), f)
	}
	h.serveObject(w, r, thumbKey(f.ID), "preview-"+f.Name, contentType, f.CreatedAt, false)
}

// thumbType reads the type of a stored preview from its first bytes.
func (fs *Files) thumbType(ctx context.Context, f store.File) string {
	obj, err := fs.Store.Open(ctx, thumbKey(f.ID))
	if err != nil {
		return "image/jpeg"
	}
	defer func() { _ = obj.Close() }()
	head := make([]byte, 16)
	n, _ := io.ReadFull(obj, head)
	return preview.Sniff(head[:n])
}

// ListChannelFiles implements api.ServerInterface.
func (h *Handlers) ListChannelFiles(w http.ResponseWriter, r *http.Request, channelID openapi_types.UUID, params api.ListChannelFilesParams) {
	p, ok := auth.RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return
	}
	if _, _, ok := h.memberChannel(w, r, channelID, p.User); !ok {
		return
	}
	var before pgtype.UUID
	if params.Before != nil {
		before = pgUUID(*params.Before)
	}
	rows, err := h.Queries.ListChannelFiles(r.Context(), store.ListChannelFilesParams{
		ChannelID: pgUUID(channelID), Before: before, RowLimit: filesPage + 1,
	})
	if err != nil {
		h.unavailable(w, r, "list files", err)
		return
	}
	more := len(rows) > filesPage
	rows = rows[:min(len(rows), filesPage)]
	out := make([]api.ChannelFile, 0, len(rows))
	for _, row := range rows {
		info := fileAPI(store.File{ID: row.ID, Name: row.Name, ContentType: row.ContentType, Size: row.Size,
			Width: row.Width, Height: row.Height, HasThumbnail: row.HasThumbnail})
		out = append(out, api.ChannelFile{
			Id: info.Id, Name: info.Name, ContentType: info.ContentType, Size: info.Size, Width: info.Width,
			Height: info.Height, HasThumbnail: info.HasThumbnail, MessageId: uuid(row.MessageID),
			Uploader: api.Author{Id: uuid(row.UploaderID), DisplayName: row.UploaderName}, CreatedAt: row.CreatedAt,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Files   []api.ChannelFile `json:"files"`
		HasMore bool              `json:"has_more"`
	}{out, more})
}

// PruneFiles removes uploads that were never sent and files of purged
// messages, with their bytes; it returns how many it removed.
func (fs *Files) PruneFiles(ctx context.Context, q *store.Queries) (int, error) {
	if fs == nil || fs.Store == nil {
		return 0, nil
	}
	rows, err := q.ListStaleFiles(ctx, 200)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, f := range rows {
		if err := fs.Store.Remove(ctx, fileKey(f.ID)); err != nil {
			continue // try again next time
		}
		if _, ok := fs.Store.(storage.Staged); ok {
			_ = fs.Store.Remove(ctx, uploadKey(f.ID))
		}
		if f.HasThumbnail {
			_ = fs.Store.Remove(ctx, thumbKey(f.ID))
		}
		ids = append(ids, f.ID)
	}
	return len(ids), q.DeleteFiles(ctx, ids)
}
