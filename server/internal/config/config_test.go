// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"errors"
	"io/fs"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) LookupFunc {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

func files(m map[string]string) ReadFileFunc {
	return func(name string) ([]byte, error) {
		v, ok := m[name]
		if !ok {
			return nil, fs.ErrNotExist
		}
		return []byte(v), nil
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"CENACLE_DATABASE_URL": "postgres://u:p@localhost:15432/chat",
	}), files(nil))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HTTPAddr != ":8180" {
		t.Errorf("HTTPAddr = %q", cfg.HTTPAddr)
	}
	if cfg.LogFormat != "text" {
		t.Errorf("development LogFormat = %q, want text", cfg.LogFormat)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v", cfg.LogLevel)
	}
	if cfg.ReadyTimeout != 2*time.Second {
		t.Errorf("ReadyTimeout = %v", cfg.ReadyTimeout)
	}
}

func TestLoadProductionDefaultsToJSON(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"CENACLE_ENV":          "production",
		"CENACLE_DATABASE_URL": "postgresql://localhost/chat",
	}), files(nil))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.LogFormat != "json" {
		t.Errorf("LogFormat = %q, want json", cfg.LogFormat)
	}
}

func TestLoadFromFile(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"CENACLE_DATABASE_URL_FILE":    "/run/secrets/db",
		"CENACLE_VALKEY_PASSWORD_FILE": "/run/secrets/valkey",
	}), files(map[string]string{
		"/run/secrets/db":     "postgres://secret@db/chat\n",
		"/run/secrets/valkey": "s3cret\n",
	}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DatabaseURL != "postgres://secret@db/chat" {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.ValkeyPassword != "s3cret" {
		t.Errorf("ValkeyPassword = %q", cfg.ValkeyPassword)
	}
}

// Compose passes settings left out of .env.prod as empty values: they leave
// the secret file in charge.
func TestLoadEmptyValueYieldsToFile(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"CENACLE_DATABASE_URL":         "postgres://localhost/chat",
		"CENACLE_VALKEY_PASSWORD":      "",
		"CENACLE_VALKEY_PASSWORD_FILE": "/run/secrets/valkey",
	}), files(map[string]string{"/run/secrets/valkey": "s3cret\n"}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ValkeyPassword != "s3cret" {
		t.Errorf("ValkeyPassword = %q", cfg.ValkeyPassword)
	}
}

func TestLoadReportsAllErrors(t *testing.T) {
	_, err := Load(env(map[string]string{
		"CENACLE_ENV":                  "staging",
		"CENACLE_HTTP_ADDR":            "8180",
		"CENACLE_LOG_LEVEL":            "loud",
		"CENACLE_READY_TIMEOUT":        "-1s",
		"CENACLE_DATABASE_URL":         "mysql://x",
		"CENACLE_VALKEY_ADDR":          "valkey",
		"CENACLE_VALKEY_PASSWORD":      "a",
		"CENACLE_VALKEY_PASSWORD_FILE": "/x",
	}), files(nil))
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{
		"CENACLE_ENV", "CENACLE_HTTP_ADDR", "CENACLE_LOG_LEVEL", "CENACLE_READY_TIMEOUT",
		"CENACLE_DATABASE_URL", "CENACLE_VALKEY_ADDR", "CENACLE_VALKEY_PASSWORD and",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

func TestLoadMissingDatabaseURL(t *testing.T) {
	_, err := Load(env(nil), files(nil))
	if err == nil || !strings.Contains(err.Error(), "CENACLE_DATABASE_URL: required") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadMissingSecretFile(t *testing.T) {
	_, err := Load(env(map[string]string{
		"CENACLE_DATABASE_URL_FILE": "/missing",
	}), files(nil))
	if err == nil || !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v, want fs.ErrNotExist", err)
	}
}

func TestLoadServe(t *testing.T) {
	base := map[string]string{
		"CENACLE_DATABASE_URL":       "postgres://u:p@localhost/chat",
		"CENACLE_OIDC_CLIENT_SECRET": "secret",
	}
	cfg, err := LoadServe(env(base), files(nil))
	if err != nil {
		t.Fatalf("LoadServe: %v", err)
	}
	if cfg.PublicURL.String() != "http://localhost:15173" || cfg.OIDCIssuer != "http://localhost:8190" ||
		// Sessions last until sign-out by default (v0.29): no idle timeout, no maximum age.
		cfg.OIDCClientID != "cenacle-chat" || cfg.SessionIdleTimeout != 0 ||
		cfg.SessionMaxAge != 0 || cfg.OIDCBackchannelURL != nil {
		t.Errorf("defaults = %+v", cfg)
	}

	// Migrations do not need the OIDC client.
	if _, err := Load(env(map[string]string{"CENACLE_DATABASE_URL": base["CENACLE_DATABASE_URL"]}), files(nil)); err != nil {
		t.Errorf("Load without OIDC settings: %v", err)
	}

	bad := map[string]string{
		"CENACLE_ENV":                  "production",
		"CENACLE_DATABASE_URL":         "postgres://db/chat",
		"CENACLE_PUBLIC_URL":           "http://chat.example.com/app",
		"CENACLE_OIDC_ISSUER":          "http://id.example.com",
		"CENACLE_OIDC_BACKCHANNEL_URL": "idp:8190",
		"CENACLE_TRUST_PROXY":          "yes",
		"CENACLE_SESSION_IDLE_TIMEOUT": "48h",
		"CENACLE_SESSION_MAX_AGE":      "24h",
	}
	_, err = LoadServe(env(bad), files(nil))
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{
		"CENACLE_PUBLIC_URL", "CENACLE_OIDC_ISSUER: must use https", "CENACLE_OIDC_BACKCHANNEL_URL",
		"CENACLE_TRUST_PROXY", "CENACLE_OIDC_CLIENT_SECRET: required", "CENACLE_SESSION_IDLE_TIMEOUT",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %q:\n%v", want, err)
		}
	}

	prod := map[string]string{
		"CENACLE_ENV":                  "production",
		"CENACLE_DATABASE_URL":         "postgres://db/chat",
		"CENACLE_PUBLIC_URL":           "https://chat.example.com/",
		"CENACLE_OIDC_ISSUER":          "https://id.example.com",
		"CENACLE_OIDC_BACKCHANNEL_URL": "http://idp:8190",
		"CENACLE_OIDC_CLIENT_SECRET":   "secret",
		"CENACLE_TRUST_PROXY":          "true",
	}
	cfg, err = LoadServe(env(prod), files(nil))
	if err != nil {
		t.Fatalf("production: %v", err)
	}
	if cfg.PublicURL.String() != "https://chat.example.com" || !cfg.TrustProxy || cfg.OIDCBackchannelURL.Host != "idp:8190" {
		t.Errorf("production = %+v", cfg)
	}
}

func TestChannelSettings(t *testing.T) {
	base := map[string]string{"CENACLE_DATABASE_URL": "postgres://u:p@localhost/chat"}
	cfg, err := Load(env(base), files(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AnnouncementChannel != "Central" || len(cfg.DefaultChannels) != 1 || cfg.DefaultChannels[0] != "General" ||
		cfg.AdminEmail != "" {
		t.Errorf("defaults: %q %v %q", cfg.AnnouncementChannel, cfg.DefaultChannels, cfg.AdminEmail)
	}

	base["CENACLE_DEFAULT_CHANNELS"] = " General , Release notes,,"
	base["CENACLE_ANNOUNCEMENT_CHANNEL"] = ""
	base["CENACLE_ADMIN_EMAIL"] = " admin@example.com "
	cfg, err = Load(env(base), files(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AnnouncementChannel != "" || len(cfg.DefaultChannels) != 2 || cfg.DefaultChannels[1] != "Release notes" ||
		cfg.AdminEmail != "admin@example.com" {
		t.Errorf("custom: %q %v %q", cfg.AnnouncementChannel, cfg.DefaultChannels, cfg.AdminEmail)
	}

	base["CENACLE_ANNOUNCEMENT_CHANNEL"] = "general"
	base["CENACLE_ADMIN_EMAIL"] = "not-an-address"
	base["CENACLE_OIDC_CLIENT_SECRET"] = "secret"
	_, err = LoadServe(env(base), files(nil))
	if err == nil || !strings.Contains(err.Error(), "configured twice") || !strings.Contains(err.Error(), "CENACLE_ADMIN_EMAIL") {
		t.Errorf("errors = %v", err)
	}
}

func TestLoadSessionLimits(t *testing.T) {
	base := map[string]string{
		"CENACLE_DATABASE_URL":       "postgres://u:p@localhost/chat",
		"CENACLE_OIDC_CLIENT_SECRET": "secret",
	}
	with := func(extra map[string]string) map[string]string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	for _, none := range []string{"0", "none"} {
		cfg, err := LoadServe(env(with(map[string]string{
			"CENACLE_SESSION_IDLE_TIMEOUT": none, "CENACLE_SESSION_MAX_AGE": none,
		})), files(nil))
		if err != nil || cfg.SessionIdleTimeout != 0 || cfg.SessionMaxAge != 0 {
			t.Fatalf("%q: %v %v %v", none, err, cfg.SessionIdleTimeout, cfg.SessionMaxAge)
		}
	}
	// A limit on only one of them is fine; both set, idle must not exceed the maximum.
	cfg, err := LoadServe(env(with(map[string]string{"CENACLE_SESSION_IDLE_TIMEOUT": "168h"})), files(nil))
	if err != nil || cfg.SessionIdleTimeout != 168*time.Hour || cfg.SessionMaxAge != 0 {
		t.Fatalf("idle only: %v %v %v", err, cfg.SessionIdleTimeout, cfg.SessionMaxAge)
	}
	if _, err := LoadServe(env(with(map[string]string{"CENACLE_SESSION_IDLE_TIMEOUT": "soon"})), files(nil)); err == nil {
		t.Fatal("expected an error for an invalid limit")
	}
}

func TestLoadValueWinsOverEmptyFile(t *testing.T) {
	// prod.yml always mounts secrets/smtp_password; an empty one leaves the
	// password to CENACLE_SMTP_PASSWORD.
	cfg, err := Load(env(map[string]string{
		"CENACLE_DATABASE_URL":       "postgres://localhost/chat",
		"CENACLE_SMTP_PASSWORD":      "pw",
		"CENACLE_SMTP_PASSWORD_FILE": "/run/secrets/smtp_password",
	}), files(map[string]string{"/run/secrets/smtp_password": "\n"}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SMTPPassword != "pw" {
		t.Errorf("SMTPPassword = %q", cfg.SMTPPassword)
	}
	// Both with content stays an error.
	_, err = Load(env(map[string]string{
		"CENACLE_DATABASE_URL":       "postgres://localhost/chat",
		"CENACLE_SMTP_PASSWORD":      "pw",
		"CENACLE_SMTP_PASSWORD_FILE": "/run/secrets/smtp_password",
	}), files(map[string]string{"/run/secrets/smtp_password": "other\n"}))
	if err == nil || !strings.Contains(err.Error(), "CENACLE_SMTP_PASSWORD and") {
		t.Fatalf("err = %v, want both set", err)
	}
}

func TestLoadFilesBackend(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
		want string
	}{
		{"unset without endpoint", nil, ""},
		{"unset with endpoint", map[string]string{"CENACLE_S3_ENDPOINT": "http://garage:3900"}, "s3"},
		// prod.yml passes ${CENACLE_FILES_BACKEND:-}: empty must not turn files off.
		{"empty with endpoint", map[string]string{"CENACLE_FILES_BACKEND": "", "CENACLE_S3_ENDPOINT": "http://garage:3900"}, "s3"},
		{"off with endpoint", map[string]string{"CENACLE_FILES_BACKEND": "off", "CENACLE_S3_ENDPOINT": "http://garage:3900"}, ""},
		{"dir", map[string]string{"CENACLE_FILES_BACKEND": "dir", "CENACLE_S3_ENDPOINT": "http://garage:3900"}, "dir"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]string{"CENACLE_DATABASE_URL": "postgres://localhost/chat"}
			for k, v := range tc.env {
				m[k] = v
			}
			cfg, err := Load(env(m), files(nil))
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if cfg.FilesBackend != tc.want {
				t.Errorf("FilesBackend = %q, want %q", cfg.FilesBackend, tc.want)
			}
		})
	}
}

func TestSourceURL(t *testing.T) {
	base := map[string]string{"CENACLE_DATABASE_URL": "postgres://u:p@localhost/chat"}
	cfg, err := Load(env(base), files(nil))
	if err != nil || cfg.SourceURL != DefaultSourceURL {
		t.Fatalf("default = %q, %v", cfg.SourceURL, err)
	}
	base["CENACLE_SOURCE_URL"] = "https://git.example.com/our/cenacle"
	if cfg, err := Load(env(base), files(nil)); err != nil || cfg.SourceURL != base["CENACLE_SOURCE_URL"] {
		t.Errorf("changed = %q, %v", cfg.SourceURL, err)
	}
	base["CENACLE_SOURCE_URL"] = "ftp://example.com/src"
	if _, err := Load(env(base), files(nil)); err == nil || !strings.Contains(err.Error(), "CENACLE_SOURCE_URL") {
		t.Errorf("ftp address accepted: %v", err)
	}
}
