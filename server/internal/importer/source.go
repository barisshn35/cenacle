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

// Open makes an export readable as a file tree: a directory, a .zip or a
// .tar.gz (unpacked into a temporary directory that close removes).
func Open(name string) (fs.FS, func() error, error) {
	info, err := os.Stat(name)
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		return os.DirFS(name), func() error { return nil }, nil
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
		return os.DirFS(dir), cleanup, nil
	}
	return nil, nil, fmt.Errorf("%s: expected a directory, a .zip or a .tar.gz", name)
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
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
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
			_, err = io.Copy(out, io.LimitReader(tr, maxEntry))
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
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
