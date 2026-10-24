// SPDX-License-Identifier: AGPL-3.0-only

package storage_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/storage"
)

// tickets is an in-memory storage.Tickets.
type tickets struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (t *tickets) PutNew(_ context.Context, key string, value []byte, _ time.Duration) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.m[key]; ok {
		return errors.New("exists")
	}
	t.m[key] = value
	return nil
}

func (t *tickets) Take(_ context.Context, key string) ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	v, ok := t.m[key]
	if !ok {
		return nil, errors.New("not found")
	}
	delete(t.m, key)
	return v, nil
}

func newTickets() *tickets { return &tickets{m: map[string][]byte{}} }

// receiver is a store that takes browser uploads.
type receiver interface {
	storage.Store
	http.Handler
}

// exercise runs the same checks on any store.
func exercise(t *testing.T, s storage.Store) {
	ctx := context.Background()
	if err := s.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Size(ctx, "files/missing"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("size of a missing object: %v", err)
	}
	if _, err := s.Open(ctx, "files/missing"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("open of a missing object: %v", err)
	}
	data := []byte("hello, object store")
	if err := s.Put(ctx, "thumbs/a b", bytes.NewReader(data), int64(len(data)), "text/plain"); err != nil {
		t.Fatal(err)
	}
	if n, err := s.Size(ctx, "thumbs/a b"); err != nil || n != int64(len(data)) {
		t.Fatalf("size = %d, %v", n, err)
	}
	obj, err := s.Open(ctx, "thumbs/a b")
	if err != nil {
		t.Fatal(err)
	}
	part := make([]byte, 6)
	if n, err := obj.ReadAt(part, 7); n != 6 || string(part) != "object" || (err != nil && !errors.Is(err, io.EOF)) {
		t.Fatalf("ReadAt = %q, %v", part[:n], err)
	}
	if _, err := obj.Seek(7, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	rest, err := io.ReadAll(obj)
	if err != nil || string(rest) != "object store" {
		t.Fatalf("read after seek = %q, %v", rest, err)
	}
	_ = obj.Close()
	if err := s.Remove(ctx, "thumbs/a b"); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(ctx, "thumbs/a b"); err != nil {
		t.Fatalf("removing twice: %v", err)
	}

	// A large object (several blocks for Azure).
	big := bytes.Repeat([]byte("0123456789abcdef"), (17<<20)/16+3)
	if err := s.Put(ctx, "files/big", bytes.NewReader(big), int64(len(big)), "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	obj, err = s.Open(ctx, "files/big")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(obj)
	if err != nil || !bytes.Equal(got, big) {
		t.Fatalf("big object: %d bytes, %v", len(got), err)
	}
	_ = obj.Close()
	_ = s.Remove(ctx, "files/big")

	if r, ok := s.(receiver); ok {
		exerciseUploads(t, r)
	}
}

func uploadForm(t *testing.T, u storage.Upload, file []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range u.Fields {
		_ = w.WriteField(k, v)
	}
	fw, _ := w.CreateFormFile("file", "x.bin")
	_, _ = fw.Write(file)
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/uploads", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	return req
}

func exerciseUploads(t *testing.T, s receiver) {
	ctx := context.Background()
	file := []byte("uploaded by a browser")
	u, err := s.UploadForm(ctx, "files/up", int64(len(file)), time.Minute)
	if err != nil || u.URL != "https://chat.example/api/uploads" || u.Fields["ticket"] == "" {
		t.Fatalf("form = %+v, %v", u, err)
	}
	// The wrong size is refused, and the form can be used again.
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, uploadForm(t, u, append(file, '!')))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("too large: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, uploadForm(t, u, file[:5]))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("too small: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, uploadForm(t, u, file))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	if n, err := s.Size(ctx, "files/up"); err != nil || n != int64(len(file)) {
		t.Fatalf("uploaded size = %d, %v", n, err)
	}
	// A form is used once.
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, uploadForm(t, u, file))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("second use: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, uploadForm(t, storage.Upload{Fields: map[string]string{"ticket": "made-up"}}, file))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("made-up ticket: %d", rec.Code)
	}
	_ = s.Remove(ctx, "files/up")
}

func TestDir(t *testing.T) {
	d, err := storage.NewDir(t.TempDir(), "https://chat.example/api/uploads", newTickets())
	if err != nil {
		t.Fatal(err)
	}
	exercise(t, d)
	if err := d.Put(context.Background(), "../escape", strings.NewReader("x"), 1, ""); err == nil {
		t.Error("a key outside the directory was written")
	}
	if _, err := storage.NewDir("relative", "", nil); err == nil {
		t.Error("a relative directory was accepted")
	}
}

// TestAzure runs against Azurite or Azure when CENACLE_TEST_AZURE_ENDPOINT,
// _ACCOUNT, _KEY and _CONTAINER (an existing container) are set.
func TestAzure(t *testing.T) {
	endpoint := os.Getenv("CENACLE_TEST_AZURE_ENDPOINT")
	if endpoint == "" {
		t.Skip("CENACLE_TEST_AZURE_ENDPOINT not set")
	}
	a, err := storage.NewAzure(storage.AzureConfig{
		Endpoint: endpoint, Account: os.Getenv("CENACLE_TEST_AZURE_ACCOUNT"),
		Key: os.Getenv("CENACLE_TEST_AZURE_KEY"), Container: os.Getenv("CENACLE_TEST_AZURE_CONTAINER"),
	}, "https://chat.example/api/uploads", newTickets())
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Check(context.Background()); err != nil {
		if err := a.CreateContainer(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	exercise(t, a)
	bad, _ := storage.NewAzure(storage.AzureConfig{
		Endpoint: endpoint, Account: os.Getenv("CENACLE_TEST_AZURE_ACCOUNT"),
		Key: "d3JvbmcK", Container: os.Getenv("CENACLE_TEST_AZURE_CONTAINER"),
	}, "", nil)
	if err := bad.Check(context.Background()); err == nil {
		t.Error("a wrong key was accepted")
	}
}
