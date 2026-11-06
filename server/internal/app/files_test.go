// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/clamav"
	"github.com/Cenacle-TR/cenacle/server/internal/storage"
)

type fileInfo struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ContentType  string `json:"content_type"`
	Size         int64  `json:"size"`
	Width        *int   `json:"width"`
	Height       *int   `json:"height"`
	HasThumbnail bool   `json:"has_thumbnail"`
}

type upload struct {
	File   fileInfo `json:"file"`
	Upload struct {
		URL    string            `json:"url"`
		Fields map[string]string `json:"fields"`
	} `json:"upload"`
}

// postForm sends a file with an upload form, like a browser.
func postForm(t *testing.T, u upload, data []byte) int {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range u.Upload.Fields {
		_ = w.WriteField(k, v)
	}
	part, _ := w.CreateFormFile("file", u.File.Name)
	_, _ = part.Write(data)
	_ = w.Close()
	res, err := http.Post(u.Upload.URL, w.FormDataContentType(), &buf)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	return res.StatusCode
}

// uploadFile uploads and completes a file; it returns the ready file.
func (s *stack) uploadFile(token, channelID, name, contentType string, data []byte) fileInfo {
	s.t.Helper()
	var u upload
	if res := s.call(http.MethodPost, "/api/channels/"+channelID+"/files", token,
		map[string]any{"name": name, "size": len(data), "content_type": contentType}, &u); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("create upload = %d", res.StatusCode)
	}
	if status := postForm(s.t, u, data); status/100 != 2 {
		s.t.Fatalf("upload = %d", status)
	}
	var f fileInfo
	if res := s.call(http.MethodPost, "/api/files/"+u.File.ID+"/complete", token, nil, &f); res.StatusCode != http.StatusOK {
		s.t.Fatalf("complete = %d", res.StatusCode)
	}
	return f
}

// get fetches a path and returns status, headers and body.
func (s *stack) get(token, path string) (int, http.Header, []byte) {
	s.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.client.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, body
}

func pngImage(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 0xff
	}
	img.SetNRGBA(0, 0, color.NRGBA{0, 0, 0, 0})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFilesUploadSendAndServe(t *testing.T) {
	t.Run("s3", func(t *testing.T) { testFilesUploadSendAndServe(t, options{files: true}) })
	t.Run("dir", func(t *testing.T) { testFilesUploadSendAndServe(t, options{files: true, dir: true}) })
}

func testFilesUploadSendAndServe(t *testing.T, o options) {
	s := newStack(t, newShared(t), o)
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)

	var session struct {
		Permissions struct {
			UploadFiles bool  `json:"upload_files"`
			MaxFileSize int64 `json:"max_file_size"`
		} `json:"permissions"`
	}
	s.call(http.MethodGet, "/api/session", ayse, nil, &session)
	if !session.Permissions.UploadFiles || session.Permissions.MaxFileSize != 5<<20 {
		t.Errorf("permissions = %+v", session.Permissions)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/files", ayse,
		map[string]any{"name": "big.iso", "size": 6 << 20}); status != http.StatusRequestEntityTooLarge || code != "file_too_large" {
		t.Errorf("too large = %d %s", status, code)
	}

	// An image: recognized, measured and previewed.
	img := s.uploadFile(ayse, general, "../../ekran görüntüsü.png", "image/png", pngImage(t, 1200, 600))
	if img.Name != "ekran görüntüsü.png" || img.ContentType != "image/png" || !img.HasThumbnail ||
		img.Width == nil || *img.Width != 1200 || *img.Height != 600 {
		t.Fatalf("image = %+v", img)
	}
	// A page that claims to be an image is not shown as one.
	page := s.uploadFile(ayse, general, "x.png", "image/png", []byte("<html><script>alert(1)</script></html>"))
	if page.ContentType != "application/octet-stream" || page.HasThumbnail {
		t.Errorf("fake image = %+v", page)
	}
	doc := s.uploadFile(ayse, general, "rapor.pdf", "application/pdf", []byte("%PDF-1.7 fake"))

	// Only the uploader reaches an unsent file.
	mert := s.user("sub-m", "Mert")
	if status, _, _ := s.get(mert, "/api/files/"+img.ID+"/content"); status != http.StatusNotFound {
		t.Errorf("unsent file for another = %d", status)
	}

	var m struct {
		message
		Files []fileInfo `json:"files"`
	}
	res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse, map[string]any{
		"body": "", "nonce": "files-0001", "file_ids": []string{img.ID, doc.ID},
	}, &m)
	if res.StatusCode != http.StatusCreated || len(m.Files) != 2 || m.Files[0].ID != img.ID {
		t.Fatalf("message with files = %d %+v", res.StatusCode, m.Files)
	}
	// A file goes with one message only.
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", ayse, map[string]any{
		"body": "again", "nonce": "files-0002", "file_ids": []string{img.ID},
	}); status != http.StatusBadRequest || code != "files_unavailable" {
		t.Errorf("file sent twice = %d %s", status, code)
	}
	// Someone else's upload cannot be sent.
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", admin, map[string]any{
		"body": "mine?", "nonce": "files-0003", "file_ids": []string{page.ID},
	}); status != http.StatusBadRequest || code != "files_unavailable" {
		t.Errorf("another's file = %d %s", status, code)
	}

	// Members read it: images inline, other types downloaded, with a sandbox.
	status, hdr, body := s.get(mert, "/api/files/"+img.ID+"/content")
	if status != http.StatusOK || hdr.Get("Content-Type") != "image/png" || !strings.HasPrefix(hdr.Get("Content-Disposition"), "inline") ||
		!strings.Contains(hdr.Get("Content-Security-Policy"), "sandbox") || len(body) == 0 {
		t.Errorf("image content = %d %v", status, hdr)
	}
	_, hdr, _ = s.get(mert, "/api/files/"+img.ID+"/content?download=true")
	if !strings.HasPrefix(hdr.Get("Content-Disposition"), "attachment") || !strings.Contains(hdr.Get("Content-Disposition"), "filename*=utf-8''ekran%20g%C3%B6r%C3%BCnt%C3%BCs%C3%BC.png") {
		t.Errorf("download disposition = %q", hdr.Get("Content-Disposition"))
	}
	status, _, thumb := s.get(mert, "/api/files/"+img.ID+"/thumbnail")
	if cfg, err := png.DecodeConfig(bytes.NewReader(thumb)); status != http.StatusOK || err != nil || cfg.Width != 480 || cfg.Height != 240 {
		t.Errorf("thumbnail = %d %v %+v", status, err, cfg)
	}
	// Ranges work (video seeking).
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+"/api/files/"+doc.ID+"/content", nil)
	req.Header.Set("Authorization", "Bearer "+mert)
	req.Header.Set("Range", "bytes=0-3")
	rres, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	part, _ := io.ReadAll(rres.Body)
	_ = rres.Body.Close()
	if rres.StatusCode != http.StatusPartialContent || string(part) != "%PDF" {
		t.Errorf("range = %d %q", rres.StatusCode, part)
	}

	// Pages and the files tab carry them; a non-member sees nothing.
	var pageOf struct {
		Messages []struct {
			Files []fileInfo `json:"files"`
		} `json:"messages"`
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/messages", ayse, nil, &pageOf)
	if last := pageOf.Messages[len(pageOf.Messages)-1]; len(last.Files) != 2 {
		t.Errorf("page files = %+v", last.Files)
	}
	var tab struct {
		Files []struct {
			fileInfo
			Uploader struct {
				DisplayName string `json:"display_name"`
			} `json:"uploader"`
		} `json:"files"`
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/files", mert, nil, &tab)
	if len(tab.Files) != 2 || tab.Files[0].Uploader.DisplayName != "Ayşe" {
		t.Errorf("files tab = %+v", tab.Files)
	}
	var private channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Gizli", "visibility": "private"}, &private)
	secret := s.uploadFile(admin, private.ID, "plan.txt", "text/plain", []byte("gizli plan"))
	s.call(http.MethodPost, "/api/channels/"+private.ID+"/messages", admin, map[string]any{
		"body": "plan", "nonce": "files-0004", "file_ids": []string{secret.ID},
	}, nil)
	if status, _, _ := s.get(mert, "/api/files/"+secret.ID+"/content"); status == http.StatusOK {
		t.Errorf("private file for a non-member = %d", status)
	}

	// Deleting the message hides its files.
	s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+m.ID, ayse, nil, nil)
	if status, _, _ := s.get(mert, "/api/files/"+img.ID+"/content"); status != http.StatusNotFound {
		t.Errorf("file of a deleted message = %d", status)
	}

	// An unsent upload can be removed; stale ones are pruned.
	if res := s.call(http.MethodDelete, "/api/files/"+page.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete upload = %d", res.StatusCode)
	}
	stale := s.uploadFile(ayse, general, "old.txt", "text/plain", []byte("old"))
	if _, err := s.pool.Exec(context.Background(), "UPDATE files SET created_at = now() - interval '2 days' WHERE id = $1", stale.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := s.bg.PruneFiles(context.Background()); err != nil || n != 1 {
		t.Errorf("pruned %d, %v", n, err)
	}
}

func TestFilesDisabledAndIncomplete(t *testing.T) {
	off := newStack(t, newShared(t), options{})
	ayse := off.user("sub-a", "Ayşe")
	if status, code := problemCode(t, off, http.MethodPost, "/api/channels/"+off.general(ayse)+"/files", ayse,
		map[string]any{"name": "a.txt", "size": 3}); status != http.StatusServiceUnavailable || code != "files_disabled" {
		t.Errorf("without storage = %d %s", status, code)
	}

	s := newStack(t, newShared(t), options{files: true})
	ayse = s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	var u upload
	s.call(http.MethodPost, "/api/channels/"+general+"/files", ayse, map[string]any{"name": "a.txt", "size": 10}, &u)
	if status, code := problemCode(t, s, http.MethodPost, "/api/files/"+u.File.ID+"/complete", ayse, nil); status != http.StatusConflict || code != "upload_incomplete" {
		t.Errorf("complete before upload = %d %s", status, code)
	}
	// Unsent uploads are limited per person.
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO files (workspace_id, channel_id, uploader_id, name, content_type, size)
		SELECT c.workspace_id, c.id, u.id, 'x', 'text/plain', 1 FROM channels c, users u, generate_series(1, 49)
		WHERE c.id = $1 AND u.auth_data = 'sub-a'`, general); err != nil {
		t.Fatal(err)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/files", ayse,
		map[string]any{"name": "b.txt", "size": 3}); status != http.StatusConflict || code != "too_many_uploads" {
		t.Errorf("51st upload = %d %s", status, code)
	}

	// The form accepts exactly the announced size.
	if status := postForm(t, u, []byte("too short")); status/100 == 2 {
		t.Errorf("short upload = %d", status)
	}
}

// fakeClamd answers like clamd: FOUND when the stream contains "EICAR".
func fakeClamd(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				r := bufio.NewReader(conn)
				_, _ = r.ReadString(0)
				var data bytes.Buffer
				size := make([]byte, 4)
				for {
					if _, err := io.ReadFull(r, size); err != nil {
						return
					}
					n := binary.BigEndian.Uint32(size)
					if n == 0 {
						break
					}
					_, _ = io.CopyN(&data, r, int64(n))
				}
				verdict := "stream: OK\x00"
				if strings.Contains(data.String(), "EICAR") {
					verdict = "stream: Eicar-Test-Signature FOUND\x00"
				}
				_, _ = io.WriteString(conn, verdict)
			}()
		}
	}()
	return l.Addr().String()
}

func TestFilesVirusScan(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true, scanner: &clamav.Scanner{Addr: fakeClamd(t)}})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	if f := s.uploadFile(ayse, general, "ok.txt", "text/plain", []byte("merhaba")); f.ContentType != "text/plain" {
		t.Errorf("clean = %+v", f)
	}
	var u upload
	data := []byte("X5O EICAR test")
	s.call(http.MethodPost, "/api/channels/"+general+"/files", ayse, map[string]any{"name": "bad.exe", "size": len(data)}, &u)
	postForm(t, u, data)
	if status, code := problemCode(t, s, http.MethodPost, "/api/files/"+u.File.ID+"/complete", ayse, nil); status != http.StatusUnprocessableEntity || code != "file_blocked" {
		t.Errorf("infected = %d %s", status, code)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", ayse, map[string]any{
		"body": "x", "nonce": "virus-0001", "file_ids": []string{u.File.ID},
	}); status != http.StatusBadRequest || code != "files_unavailable" {
		t.Errorf("sending a blocked file = %d %s", status, code)
	}
}

// An upload form used again after the file was checked does not replace it.
func TestFilesFormCannotReplaceACheckedFile(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	first := []byte("the checked text")
	var u upload
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/files", ayse,
		map[string]any{"name": "a.txt", "size": len(first), "content_type": "text/plain"}, &u); res.StatusCode != http.StatusCreated {
		t.Fatalf("create upload = %d", res.StatusCode)
	}
	if status := postForm(t, u, first); status/100 != 2 {
		t.Fatalf("upload = %d", status)
	}
	if res := s.call(http.MethodPost, "/api/files/"+u.File.ID+"/complete", ayse, nil, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("complete = %d", res.StatusCode)
	}
	postForm(t, u, []byte("an unchecked text")) // same size, same form
	s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse,
		map[string]any{"body": "see", "nonce": "form-again-1", "file_ids": []string{u.File.ID}}, nil)
	status, _, body := s.get(ayse, "/api/files/"+u.File.ID+"/content")
	if status != http.StatusOK || string(body) != string(first) {
		t.Errorf("served %d %q, want the checked text", status, body)
	}
}

// Files that a browser would run as a page (HTML, SVG) are only ever
// downloaded, with headers that keep them from acting as the app.
func TestFilesThatCouldRunAreDownloaded(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	for i, f := range []struct{ name, ctype, data string }{
		{"page.html", "text/html", "<script>alert(1)</script>"},
		{"image.svg", "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`},
		{"script.js", "text/javascript", "alert(1)"},
	} {
		up := s.uploadFile(ayse, general, f.name, f.ctype, []byte(f.data))
		s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse,
			map[string]any{"body": "see", "nonce": fmt.Sprintf("run-%d", i), "file_ids": []string{up.ID}}, nil)
		status, hdr, _ := s.get(ayse, "/api/files/"+up.ID+"/content")
		if status != http.StatusOK || hdr.Get("Content-Type") != "application/octet-stream" ||
			!strings.HasPrefix(hdr.Get("Content-Disposition"), "attachment") ||
			hdr.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.Contains(hdr.Get("Content-Security-Policy"), "sandbox") {
			t.Errorf("%s served as %d %q %q nosniff=%q csp=%q", f.name, status, hdr.Get("Content-Type"),
				hdr.Get("Content-Disposition"), hdr.Get("X-Content-Type-Options"), hdr.Get("Content-Security-Policy"))
		}
	}
}

// pausedStage is a staged store (uploads land under uploads/, completing
// moves them to files/, like S3) whose writer stages bytes directly, as a
// reusable S3 form allows. The first completion pauses after it recognized
// the file (at its thumbnail); a second one pauses when it opens files/.
type pausedStage struct {
	*storage.Dir
	opens            atomic.Int32
	firstAtThumb     chan struct{}
	releaseFirst     chan struct{}
	secondInCheck    chan struct{}
	releaseSecond    chan struct{}
	thumbOnce, check sync.Once
}

func (s *pausedStage) Promote(ctx context.Context, from, to string) error {
	obj, err := s.Dir.Open(ctx, from)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(obj)
	_ = obj.Close()
	if err != nil {
		return err
	}
	if err := s.Dir.Put(ctx, to, bytes.NewReader(data), int64(len(data)), ""); err != nil {
		return err
	}
	return s.Remove(ctx, from)
}

func (s *pausedStage) UploadForm(context.Context, string, int64, time.Duration) (storage.Upload, error) {
	return storage.Upload{URL: "http://127.0.0.1:1/staged", Fields: map[string]string{}}, nil
}

func (s *pausedStage) Open(ctx context.Context, key string) (storage.Object, error) {
	if strings.HasPrefix(key, "files/") && s.opens.Add(1) == 2 {
		s.check.Do(func() { close(s.secondInCheck); <-s.releaseSecond })
	}
	return s.Dir.Open(ctx, key)
}

func (s *pausedStage) Put(ctx context.Context, key string, r io.Reader, size int64, ct string) error {
	if strings.HasPrefix(key, "thumbs/") {
		s.thumbOnce.Do(func() { close(s.firstAtThumb); <-s.releaseFirst })
	}
	return s.Dir.Put(ctx, key, r, size, ct)
}

// Two completions of one upload, with other bytes staged in between, must
// not pair the first one's verdict (an image, with a preview) with the
// second one's bytes: one completion at a time checks a file.
func TestCompletingAnUploadTwiceAtOnce(t *testing.T) {
	d, err := storage.NewDir(t.TempDir(), "http://127.0.0.1:1/unused", nil)
	if err != nil {
		t.Fatal(err)
	}
	st := &pausedStage{Dir: d, firstAtThumb: make(chan struct{}), releaseFirst: make(chan struct{}),
		secondInCheck: make(chan struct{}), releaseSecond: make(chan struct{})}
	s := newStack(t, newShared(t), options{store: st})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	ctx := context.Background()
	img := pngImage(t, 4, 4)
	text := bytes.Repeat([]byte("T"), len(img))

	var u upload
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/files", ayse,
		map[string]any{"name": "a.png", "size": len(img), "content_type": "image/png"}, &u); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	// Completing before the bytes arrived gives the upload back at once.
	if status, code := problemCode(t, s, http.MethodPost, "/api/files/"+u.File.ID+"/complete", ayse, nil); status != http.StatusConflict || code != "upload_incomplete" {
		t.Fatalf("complete before upload = %d %s", status, code)
	}
	if err := st.Dir.Put(ctx, "uploads/"+u.File.ID, bytes.NewReader(img), int64(len(img)), ""); err != nil {
		t.Fatal(err)
	}
	first, second := make(chan int, 1), make(chan int, 1)
	go func() {
		first <- s.call(http.MethodPost, "/api/files/"+u.File.ID+"/complete", ayse, nil, nil).StatusCode
	}()
	<-st.firstAtThumb
	if err := st.Dir.Put(ctx, "uploads/"+u.File.ID, bytes.NewReader(text), int64(len(text)), ""); err != nil {
		t.Fatal(err)
	}
	go func() {
		second <- s.call(http.MethodPost, "/api/files/"+u.File.ID+"/complete", ayse, nil, nil).StatusCode
	}()
	var secondStatus int
	select {
	case <-st.secondInCheck: // the second one got to the bytes (before the fix)
	case secondStatus = <-second:
	case <-time.After(20 * time.Second):
		t.Fatal("the second completion hangs")
	}
	close(st.releaseFirst)
	if status := <-first; status != http.StatusOK {
		t.Errorf("first completion = %d", status)
	}
	close(st.releaseSecond)
	if secondStatus == 0 {
		secondStatus = <-second
	}
	if secondStatus != http.StatusConflict {
		t.Errorf("second completion = %d, want 409 while the first checks", secondStatus)
	}

	var status, contentType string
	if err := s.pool.QueryRow(ctx, "SELECT status, content_type FROM files WHERE id = $1", u.File.ID).Scan(&status, &contentType); err != nil {
		t.Fatal(err)
	}
	obj, err := st.Dir.Open(ctx, "files/"+u.File.ID)
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := io.ReadAll(obj)
	_ = obj.Close()
	if status != "ready" || contentType != "image/png" || !bytes.Equal(stored, img) {
		t.Errorf("file %s %s holds the checked image = %v", status, contentType, bytes.Equal(stored, img))
	}
	// Completing again answers with the verdict.
	var f fileInfo
	if res := s.call(http.MethodPost, "/api/files/"+u.File.ID+"/complete", ayse, nil, &f); res.StatusCode != http.StatusOK || f.ContentType != "image/png" {
		t.Errorf("complete again = %d %s", res.StatusCode, f.ContentType)
	}
}
