// SPDX-License-Identifier: AGPL-3.0-only

package admin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/config"
)

func TestBundleHasNoSecrets(t *testing.T) {
	public, _ := url.Parse("https://chat.example.com")
	cfg := config.Config{
		DatabaseURL: "postgres://chat:hunter2@db:5432/cenacle_chat", ValkeyPassword: "valkey-pass",
		OIDCClientSecret: "oidc-secret", S3AccessKey: "GKaccess", S3SecretKey: "s3-secret",
		AdminEmail: "boss@example.com", PublicURL: public,
	}
	var buf bytes.Buffer
	if err := WriteBundle(&buf, Report{Version: "1.2.3", Time: time.Now()}, Settings(cfg)); err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var names []string
	var all strings.Builder
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, h.Name)
		b, _ := io.ReadAll(tr)
		all.Write(b)
	}
	if strings.Join(names, ",") != "cenacle-support/runtime.json,cenacle-support/settings.json,cenacle-support/status.json" {
		t.Errorf("files = %v", names)
	}
	out := all.String()
	for _, secret := range []string{"hunter2", "valkey-pass", "oidc-secret", "GKaccess", "s3-secret", "boss@example.com"} {
		if strings.Contains(out, secret) {
			t.Errorf("bundle contains %q", secret)
		}
	}
	if !strings.Contains(out, `"database": "postgres://db:5432/cenacle_chat"`) || !strings.Contains(out, `"version": "1.2.3"`) {
		t.Errorf("bundle = %s", out)
	}
}
