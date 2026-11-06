// SPDX-License-Identifier: AGPL-3.0-only

package storage_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/storage"
)

// fakeBlob records the blobs a fake Blob service committed (a whole PUT or a
// block list), without checking signatures.
type fakeBlob struct {
	mu        sync.Mutex
	committed []string
}

func (f *fakeBlob) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	if r.Method == http.MethodPut && r.URL.Query().Get("comp") != "block" {
		f.mu.Lock()
		f.committed = append(f.committed, r.URL.Path)
		f.mu.Unlock()
	}
	w.WriteHeader(http.StatusCreated)
}

// cutReader gives n bytes and then fails like a body cut off mid-way.
type cutReader struct{ n int }

func (c *cutReader) Read(p []byte) (int, error) {
	if c.n == 0 {
		return 0, io.ErrUnexpectedEOF
	}
	m := min(len(p), c.n)
	c.n -= m
	return m, nil
}

func TestAzurePutIsWholeOrNothing(t *testing.T) {
	fake := &fakeBlob{}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	a, err := storage.NewAzure(storage.AzureConfig{
		Endpoint: srv.URL + "/dev", Account: "dev", Key: "a2V5", Container: "files",
	}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	big := 9 << 20 // two blocks
	cases := []struct {
		name string
		r    io.Reader
		size int64
	}{
		{"short of size", strings.NewReader("hello"), 10},
		{"longer than size", strings.NewReader("hello world"), 5},
		{"large, short of size", bytes.NewReader(make([]byte, big)), int64(big) + 1},
		{"cut off, size unknown", &cutReader{n: 100}, -1},
		{"large, cut off", &cutReader{n: big}, int64(big) + 100},
	}
	for _, c := range cases {
		if err := a.Put(ctx, "k", c.r, c.size, "application/octet-stream"); err == nil {
			t.Errorf("%s: no error", c.name)
		}
	}
	if len(fake.committed) != 0 {
		t.Fatalf("truncated blobs committed: %v", fake.committed)
	}
	// Complete objects are committed, small and large, size known or not.
	if err := a.Put(ctx, "small", strings.NewReader("hello"), 5, "text/plain"); err != nil {
		t.Fatal(err)
	}
	if err := a.Put(ctx, "large", bytes.NewReader(make([]byte, big)), -1, "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	if err := a.Put(ctx, "exact", bytes.NewReader(make([]byte, 8<<20)), 8<<20, "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	if len(fake.committed) != 3 {
		t.Errorf("committed %v, want small, large and exact", fake.committed)
	}
}
