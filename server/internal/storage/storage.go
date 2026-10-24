// SPDX-License-Identifier: AGPL-3.0-only

// Package storage keeps files in an object store: an S3-compatible service
// (Garage by default), Azure Blob Storage or a directory on the server. The
// server reads objects back to serve them with its own access checks and
// headers. Browsers upload with a form that fixes the key and the exact size:
// straight to S3 with a POST policy, or to the server, which writes the object
// for the other backends.
package storage

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"time"
)

// ErrNotFound: no object under the key.
var ErrNotFound = errors.New("storage: object not found")

// Store is an object store.
type Store interface {
	// UploadForm allows one upload of exactly size bytes under key until expiry.
	UploadForm(ctx context.Context, key string, size int64, valid time.Duration) (Upload, error)
	// Size returns the size of an object.
	Size(ctx context.Context, key string) (int64, error)
	// Open returns an object for reading.
	Open(ctx context.Context, key string) (Object, error)
	// Put stores an object the server made (thumbnails, imports).
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	// Remove deletes an object; a missing one is not an error.
	Remove(ctx context.Context, key string) error
	// Check and Name implement health.Checker.
	Check(ctx context.Context) error
	Name() string
}

// Upload is a form a browser posts to store one object: the fields, then the
// file in a part called "file".
type Upload struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

// Object is a stored object opened for reading; it can seek (ranges).
type Object interface {
	io.ReadSeekCloser
	io.ReaderAt
}

// Tickets keeps upload tickets (Valkey): Take returns a value at most once.
type Tickets interface {
	PutNew(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Take(ctx context.Context, key string) ([]byte, error)
}

// putter is the part of a backend the receiver writes with.
type putter interface {
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
}

// Receiver takes browser uploads for a backend that browsers cannot reach
// (Azure, a directory): the upload form carries a one-time ticket for the key
// and the size, and the server writes the object.
type Receiver struct {
	tickets Tickets
	url     string
	store   putter
}

type ticket struct {
	Key  string `json:"key"`
	Size int64  `json:"size"`
}

const ticketPrefix = "upload:"

// uploadTime bounds one browser upload to the server.
const uploadTime = time.Hour

// UploadForm issues a ticket for one upload.
func (rv *Receiver) UploadForm(ctx context.Context, key string, size int64, valid time.Duration) (Upload, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return Upload{}, err
	}
	id := base64.RawURLEncoding.EncodeToString(b)
	value, err := json.Marshal(ticket{Key: key, Size: size})
	if err != nil {
		return Upload{}, err
	}
	if err := rv.tickets.PutNew(ctx, ticketPrefix+id, value, valid); err != nil {
		return Upload{}, err
	}
	return Upload{URL: rv.url, Fields: map[string]string{"ticket": id}}, nil
}

// ServeHTTP stores the file of an upload form (POST, multipart: "ticket",
// then "file").
func (rv *Receiver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// A large file takes longer than the server's request timeouts.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(uploadTime))
	_ = rc.SetWriteDeadline(time.Now().Add(uploadTime))
	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "expected a multipart form", http.StatusBadRequest)
		return
	}
	part, err := mr.NextPart()
	if err != nil || part.FormName() != "ticket" {
		http.Error(w, "the form starts with the ticket", http.StatusBadRequest)
		return
	}
	id, err := io.ReadAll(io.LimitReader(part, 64))
	if err != nil {
		http.Error(w, "bad ticket", http.StatusBadRequest)
		return
	}
	raw, err := rv.tickets.Take(r.Context(), ticketPrefix+string(id))
	if err != nil {
		http.Error(w, "the upload form expired or was used", http.StatusForbidden)
		return
	}
	var t ticket
	if err := json.Unmarshal(raw, &t); err != nil {
		http.Error(w, "bad ticket", http.StatusForbidden)
		return
	}
	if err := rv.receive(r.Context(), mr, t); err != nil {
		// The browser may try again with the same form.
		_ = rv.tickets.PutNew(context.WithoutCancel(r.Context()), ticketPrefix+string(id), raw, 10*time.Minute)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (rv *Receiver) receive(ctx context.Context, mr *multipart.Reader, t ticket) error {
	for {
		part, err := mr.NextPart()
		if err != nil {
			return errors.New("the form has no file")
		}
		if part.FormName() != "file" {
			continue
		}
		counted := &exact{r: part, left: t.Size}
		if err := rv.store.Put(ctx, t.Key, counted, t.Size, "application/octet-stream"); err != nil {
			return fmt.Errorf("storing the file: %w", err)
		}
		if counted.left != 0 || counted.over {
			return errors.New("the file is not the announced size")
		}
		return nil
	}
}

// exact reads exactly left bytes; more is an error.
type exact struct {
	r    io.Reader
	left int64
	over bool
}

func (e *exact) Read(p []byte) (int, error) {
	if e.left <= 0 {
		var one [1]byte
		if n, _ := e.r.Read(one[:]); n > 0 {
			e.over = true
			return 0, errors.New("the file is larger than announced")
		}
		return 0, io.EOF
	}
	if int64(len(p)) > e.left {
		p = p[:e.left]
	}
	n, err := e.r.Read(p)
	e.left -= int64(n)
	if errors.Is(err, io.EOF) && e.left > 0 {
		return n, io.ErrUnexpectedEOF
	}
	if errors.Is(err, io.EOF) {
		err = nil
	}
	return n, err
}
