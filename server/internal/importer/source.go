// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// maxEntry bounds one file of an export (a JSON document read whole).
const maxEntry = 512 << 20

// A .tar.gz is unpacked to disk: these bound what one export may write there
// (a few kilobytes of gzip can stand for terabytes). 64 GiB and a million
// entries are far above the exports of large workspaces (attachments
// included) and well short of filling a server's disk unnoticed. Variables so
// tests can lower them.
var (
	maxUnpacked int64 = 64 << 30
	maxEntries        = 1_000_000
)

// Open makes an export readable as a file tree: a directory, a .zip or a
// .tar.gz (unpacked into a temporary directory that close removes).
func Open(name string) (fs.FS, func() error, error) {
	info, err := os.Stat(name)
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		return openDir(name, func() error { return nil })
	}
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		zr, err := zip.OpenReader(name)
		if err != nil {
			return nil, nil, err
		}
		return zr, zr.Close, nil
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"), strings.HasSuffix(lower, ".tar"):
		dir, err := os.MkdirTemp("", "cenacle-import-")
		if err != nil {
			return nil, nil, err
		}
		cleanup := func() error { return os.RemoveAll(dir) }
		if err := untar(name, dir); err != nil {
			_ = cleanup()
			return nil, nil, err
		}
		fsys, closeDir, err := openDir(dir, cleanup)
		if err != nil {
			_ = cleanup()
		}
		return fsys, closeDir, err
	}
	return nil, nil, fmt.Errorf("%s: expected a directory, a .zip or a .tar.gz", name)
}

// errNotRegular refuses an entry of an export that is neither a plain file
// nor a directory (a device or a pipe could block or leak the host).
var errNotRegular = errors.New("not a regular file")

// openDir reads a directory export through an os.Root: a path or a link that
// leads outside the directory is refused (an export unpacked by hand may
// carry links to the host's files), and so is anything but plain files and
// directories. done runs after the root is closed.
func openDir(name string, done func() error) (fs.FS, func() error, error) {
	root, err := os.OpenRoot(name)
	if err != nil {
		return nil, nil, err
	}
	closeDir := func() error {
		return errors.Join(root.Close(), done())
	}
	return regularFS{root.FS()}, closeDir, nil
}

// regularFS opens only plain files and directories of an os.Root's FS.
type regularFS struct{ fsys fs.FS }

func (r regularFS) Open(name string) (fs.File, error) {
	// Stat before opening: opening a pipe would block.
	info, err := fs.Stat(r.fsys, name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() && !info.IsDir() {
		return nil, &fs.PathError{Op: "open", Path: name, Err: errNotRegular}
	}
	f, err := r.fsys.Open(name)
	if err != nil {
		return nil, err
	}
	// The entry may have changed between the two calls.
	if info, err = f.Stat(); err != nil || (!info.Mode().IsRegular() && !info.IsDir()) {
		_ = f.Close()
		if err == nil {
			err = &fs.PathError{Op: "open", Path: name, Err: errNotRegular}
		}
		return nil, err
	}
	return f, nil
}

func untar(name, dir string) error {
	f, err := os.Open(name) //nolint:gosec // the operator names the export to read
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	var r io.Reader = bufio.NewReader(f)
	if !strings.HasSuffix(strings.ToLower(name), ".tar") {
		gz, err := gzip.NewReader(r)
		if err != nil {
			return err
		}
		defer func() { _ = gz.Close() }()
		r = gz
	}
	tr := tar.NewReader(r)
	var (
		entries int
		written int64
	)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if entries++; entries > maxEntries {
			return fmt.Errorf("%s: more than %d entries", name, maxEntries)
		}
		// Only plain files and directories, and never outside dir.
		clean := path.Clean("/" + h.Name)[1:]
		if clean == "" || !fs.ValidPath(clean) {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(clean))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600) //nolint:gosec // target is inside dir
			if err != nil {
				return err
			}
			// One byte past the total tells an export that is too large.
			n, err := io.Copy(out, io.LimitReader(tr, min(maxEntry, maxUnpacked-written+1)))
			written += n
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
			if written > maxUnpacked {
				return fmt.Errorf("%s: unpacks to more than %d bytes", name, maxUnpacked)
			}
		}
	}
}

// readJSON decodes one file of an export.
func readJSON(fsys fs.FS, name string, v any) error {
	f, err := fsys.Open(name)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if err := json.NewDecoder(io.LimitReader(f, maxEntry)).Decode(v); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// findFile returns the path of the first file called base (an export may be
// wrapped in a top directory).
func findFile(fsys fs.FS, base string) (string, error) {
	var found string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && path.Base(p) == base {
			found = p
			return fs.SkipAll
		}
		return nil
	})
	if err == nil && found == "" {
		err = fmt.Errorf("%s is missing", base)
	}
	return found, err
}

// jsonFiles lists the .json files under dir (sorted, as fs.WalkDir walks).
func jsonFiles(fsys fs.FS, dir string) ([]string, error) {
	var out []string
	err := fs.WalkDir(fsys, dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(strings.ToLower(p), ".json") {
			out = append(out, p)
		}
		return nil
	})
	return out, err
}
