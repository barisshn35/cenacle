// SPDX-License-Identifier: Apache-2.0

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
