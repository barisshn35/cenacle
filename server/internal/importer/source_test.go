// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
