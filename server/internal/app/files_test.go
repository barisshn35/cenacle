// SPDX-License-Identifier: Apache-2.0

package app_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/clamav"
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
	s := newStack(t, newShared(t), options{files: true})
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
