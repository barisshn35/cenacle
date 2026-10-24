// SPDX-License-Identifier: AGPL-3.0-only

package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Dir keeps objects as files in a directory of the server (a single server,
// or a volume every server mounts). Keys are paths below it.
type Dir struct {
	Receiver
	root string
}

// NewDir uses dir (created if missing); browsers upload to uploadURL, where
// the server mounts the Receiver.
func NewDir(dir, uploadURL string, tickets Tickets) (*Dir, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("storage: the files directory must be an absolute path, got %q", dir)
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("storage: %w", err)
	}
	d := &Dir{root: filepath.Clean(dir)}
	d.Receiver = Receiver{tickets: tickets, url: uploadURL, store: d}
	return d, nil
}

func (d *Dir) path(key string) (string, error) {
	if !fs.ValidPath(key) || strings.Contains(key, `\`) {
		return "", fmt.Errorf("storage: invalid key %q", key)
	}
	return filepath.Join(d.root, filepath.FromSlash(key)), nil
}

// Size implements Store.
func (d *Dir) Size(_ context.Context, key string) (int64, error) {
	p, err := d.path(key)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// Open implements Store.
func (d *Dir) Open(_ context.Context, key string) (Object, error) {
	p, err := d.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p) //nolint:gosec // p is below the root (path checks the key)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

// Put implements Store: the object appears whole or not at all.
func (d *Dir) Put(_ context.Context, key string, r io.Reader, size int64, _ string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil { //nolint:gosec // p is below the root (path checks the key)
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".upload-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }() //nolint:gosec // a temporary file below the root
	n, err := io.Copy(tmp, r)
	if err == nil && size >= 0 && n != size {
		err = fmt.Errorf("storage: wrote %d of %d bytes", n, size)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p) //nolint:gosec // p is below the root (path checks the key)
}

// Remove implements Store.
func (d *Dir) Remove(_ context.Context, key string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Check implements health.Checker: the directory is there and writable.
func (d *Dir) Check(context.Context) error {
	f, err := os.CreateTemp(d.root, ".check-*")
	if err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	_ = f.Close()
	return os.Remove(f.Name())
}

// Name implements health.Checker.
func (*Dir) Name() string { return "storage" }
