// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// writeTarGz writes an export of n files of size bytes each.
func writeTarGz(t *testing.T, n, size int) string {
	t.Helper()
	name := filepath.Join(t.TempDir(), "export.tar.gz")
	f, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for i := range n {
		if err := tw.WriteHeader(&tar.Header{Name: fmt.Sprintf("f%d.json", i), Mode: 0o600, Size: int64(size), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(strings.Repeat("x", size))); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []interface{ Close() error }{tw, gz, f} {
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return name
}

func TestUntarBoundsTheExport(t *testing.T) {
	oldBytes, oldEntries := maxUnpacked, maxEntries
	t.Cleanup(func() { maxUnpacked, maxEntries = oldBytes, oldEntries })
	maxUnpacked, maxEntries = 30, 3

	// Within the bounds (exactly at them) it unpacks.
	if err := untar(writeTarGz(t, 3, 10), t.TempDir()); err != nil {
		t.Fatalf("within bounds: %v", err)
	}
	// One byte too many in all.
	if err := untar(writeTarGz(t, 2, 16), t.TempDir()); err == nil || !strings.Contains(err.Error(), "more than 30 bytes") {
		t.Errorf("too large: %v", err)
	}
	// One entry too many.
	if err := untar(writeTarGz(t, 4, 1), t.TempDir()); err == nil || !strings.Contains(err.Error(), "more than 3 entries") {
		t.Errorf("too many entries: %v", err)
	}
}

// writeDirExport writes a Cenacle export directory with one file entry and
// returns the directory and that entry's path.
func writeDirExport(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "cenacle-export.jsonl"), []byte(`{"type":"version","version":1}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "files"), 0o700); err != nil {
		t.Fatal(err)
	}
	return dir, filepath.Join(dir, "files", testFileKey)
}

const testFileKey = "0190c0de-0000-7000-8000-000000000001"

func openDirExport(t *testing.T, dir string) Data {
	t.Helper()
	fsys, closeFS, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = closeFS() })
	d, err := ReadCenacle(fsys)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestDirectoryExportRefusesEscapingLinks(t *testing.T) {
	dir, entry := writeDirExport(t)
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("outside the export"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, entry); err != nil {
		t.Fatal(err)
	}
	d := openDirExport(t, dir)
	if f, err := d.OpenFile(testFileKey); err == nil {
		_ = f.Close()
		t.Fatal("a link out of the export was followed")
	}
}

func TestDirectoryExportReadsPlainFilesOnly(t *testing.T) {
	dir, entry := writeDirExport(t)
	// A link that stays inside the export is fine.
	if err := os.WriteFile(filepath.Join(dir, "files", "data"), []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("data", entry); err != nil {
		t.Fatal(err)
	}
	d := openDirExport(t, dir)
	f, err := d.OpenFile(testFileKey)
	if err != nil {
		t.Fatalf("link inside the export: %v", err)
	}
	_ = f.Close()

	// A pipe is refused (and does not block).
	if err := os.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(entry, 0o600); err != nil {
		t.Skip("mkfifo:", err)
	}
	if f, err := d.OpenFile(testFileKey); !errors.Is(err, errNotRegular) {
		if err == nil {
			_ = f.Close()
		}
		t.Fatalf("pipe: %v", err)
	}
}
