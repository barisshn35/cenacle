// SPDX-License-Identifier: Apache-2.0

// Package config loads and validates the chat server configuration.
//
// Configuration comes from environment variables prefixed with CENACLE_.
// Every variable can alternatively be read from a file by setting
// <NAME>_FILE to a path, which is how Docker/Compose secrets are consumed.
// Setting both <NAME> and <NAME>_FILE is an error.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

// Config is the validated server configuration.
type Config struct {
	// Env is the deployment environment: "development" or "production".
	Env string
	// HTTPAddr is the listen address of the HTTP server, e.g. ":8180".
	HTTPAddr string
	// LogLevel is the minimum log level.
	LogLevel slog.Level
	// LogFormat is "json" or "text".
	LogFormat string

	// DatabaseURL is the PostgreSQL connection string of the chat database.
	DatabaseURL string
	// ValkeyAddr is the host:port of the Valkey server.
	ValkeyAddr string
	// ValkeyPassword is optional.
	ValkeyPassword string

	// ShutdownTimeout bounds graceful shutdown.
	ShutdownTimeout time.Duration
	// ReadyTimeout bounds each dependency check of /readyz.
	ReadyTimeout time.Duration
}

// LookupFunc matches os.LookupEnv; tests inject their own.
type LookupFunc func(key string) (string, bool)

// ReadFileFunc matches os.ReadFile; tests inject their own.
type ReadFileFunc func(name string) ([]byte, error)

// FromEnv loads the configuration from the process environment.
func FromEnv() (Config, error) {
	return Load(os.LookupEnv, os.ReadFile)
}

// Load builds a Config using the given lookup functions and validates it.
// All problems are reported together.
func Load(lookup LookupFunc, readFile ReadFileFunc) (Config, error) {
	l := loader{lookup: lookup, readFile: readFile}

	cfg := Config{
		Env:            l.str("CENACLE_ENV", "development"),
		HTTPAddr:       l.str("CENACLE_HTTP_ADDR", ":8180"),
		LogFormat:      l.str("CENACLE_LOG_FORMAT", ""),
		DatabaseURL:    l.str("CENACLE_DATABASE_URL", ""),
		ValkeyAddr:     l.str("CENACLE_VALKEY_ADDR", "localhost:16379"),
		ValkeyPassword: l.str("CENACLE_VALKEY_PASSWORD", ""),
	}
	cfg.LogLevel = l.level("CENACLE_LOG_LEVEL", slog.LevelInfo)
	cfg.ShutdownTimeout = l.duration("CENACLE_SHUTDOWN_TIMEOUT", 15*time.Second)
	cfg.ReadyTimeout = l.duration("CENACLE_READY_TIMEOUT", 2*time.Second)

	if cfg.LogFormat == "" {
		cfg.LogFormat = "json"
		if cfg.Env == "development" {
			cfg.LogFormat = "text"
		}
	}

	l.validate(&cfg)
	if len(l.errs) > 0 {
		return Config{}, fmt.Errorf("invalid configuration: %w", errors.Join(l.errs...))
	}
	return cfg, nil
}

type loader struct {
	lookup   LookupFunc
	readFile ReadFileFunc
	errs     []error
}

func (l *loader) fail(format string, args ...any) {
	l.errs = append(l.errs, fmt.Errorf(format, args...))
}

func (l *loader) str(key, def string) string {
	val, ok := l.lookup(key)
	file, fileOK := l.lookup(key + "_FILE")
	switch {
	case ok && fileOK:
		l.fail("%s and %s_FILE are both set; use only one", key, key)
		return def
	case fileOK:
		b, err := l.readFile(file)
		if err != nil {
			l.fail("%s_FILE: %w", key, err)
			return def
		}
		return strings.TrimRight(string(b), "\r\n")
	case ok:
		return val
	default:
		return def
	}
}

func (l *loader) duration(key string, def time.Duration) time.Duration {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		l.fail("%s: must be a positive duration such as 5s, got %q", key, raw)
		return def
	}
	return d
}

func (l *loader) level(key string, def slog.Level) slog.Level {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(raw)); err != nil {
		l.fail("%s: must be one of debug, info, warn, error, got %q", key, raw)
		return def
	}
	return lvl
}

func (l *loader) validate(cfg *Config) {
	switch cfg.Env {
	case "development", "production":
	default:
		l.fail("CENACLE_ENV: must be development or production, got %q", cfg.Env)
	}

	switch cfg.LogFormat {
	case "json", "text":
	default:
		l.fail("CENACLE_LOG_FORMAT: must be json or text, got %q", cfg.LogFormat)
	}

	if _, _, err := net.SplitHostPort(cfg.HTTPAddr); err != nil {
		l.fail("CENACLE_HTTP_ADDR: must be host:port, got %q", cfg.HTTPAddr)
	}

	if cfg.DatabaseURL == "" {
		l.fail("CENACLE_DATABASE_URL: required")
	} else if u, err := url.Parse(cfg.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		l.fail("CENACLE_DATABASE_URL: must be a postgres:// URL")
	}

	if _, _, err := net.SplitHostPort(cfg.ValkeyAddr); err != nil {
		l.fail("CENACLE_VALKEY_ADDR: must be host:port, got %q", cfg.ValkeyAddr)
	}
}
