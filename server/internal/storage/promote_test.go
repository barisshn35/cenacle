// SPDX-License-Identifier: AGPL-3.0-only
package storage_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/storage"
	"github.com/Cenacle-TR/cenacle/server/internal/testdb"
)

func TestS3Promote(t *testing.T) {
	s := testdb.Storage(t)
	ctx := context.Background()
	from, to := "uploads/promote-test", "files/promote-test"
	if err := s.Put(ctx, from, bytes.NewReader([]byte("hello")), 5, "text/plain"); err != nil {
		t.Fatal(err)
	}
	if err := s.Promote(ctx, from, to); err != nil {
		t.Fatalf("promote: %v", err)
	}
	obj, err := s.Open(ctx, to)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(obj)
	_ = obj.Close()
	if string(got) != "hello" {
		t.Errorf("promoted = %q", got)
	}
	if _, err := s.Size(ctx, from); !errors.Is(err, storage.ErrNotFound) {
		t.Errorf("the upload is still there: %v", err)
	}
	if err := s.Promote(ctx, from, to); !errors.Is(err, storage.ErrNotFound) {
		t.Errorf("promote of nothing = %v", err)
	}
	_ = s.Remove(ctx, to)
}
