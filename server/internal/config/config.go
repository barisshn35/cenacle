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
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/barisshn35/cenacle/server/internal/egress"
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
	// DrainDelay is how long /readyz fails before shutting down, so a load
	// balancer stops sending requests first (rolling upgrades).
	DrainDelay time.Duration
	// MetricsAddr serves Prometheus metrics (/metrics) on an internal address;
	// empty: off.
	MetricsAddr string

	// PublicURL is the origin users open the chat at, e.g. https://chat.example.com.
	// The OIDC redirect URI and the session cookie derive from it.
	PublicURL *url.URL
	// TrustProxy takes the client address from X-Forwarded-For (set by Caddy).
	TrustProxy bool

	// OIDCIssuer is the public issuer URL of Cenacle ID.
	OIDCIssuer string
	// OIDCBackchannelURL optionally routes server-to-IdP requests (discovery,
	// token, userinfo, JWKS) to an internal address such as http://idp:8190.
	OIDCBackchannelURL *url.URL
	// OIDCClientID and OIDCClientSecret identify the chat server at Cenacle ID.
	OIDCClientID     string
	OIDCClientSecret string

	// SessionIdleTimeout ends sessions that were not used for this long.
	SessionIdleTimeout time.Duration
	// SessionMaxAge ends sessions this long after sign-in, used or not.
	SessionMaxAge time.Duration

	// AdminEmail is the verified e-mail address of the one user who may
	// create channels and post in announcement channels (until roles, v0.6).
	AdminEmail string
	// AnnouncementChannel is created at startup as a mandatory announcement
	// channel for everyone; empty for none.
	AnnouncementChannel string
	// DefaultChannels are created at startup with every user as a member.
	DefaultChannels []string

	// EgressAllow lists private networks bots' addresses may be in (Cenacle
	// otherwise refuses loopback, private and link-local addresses).
	EgressAllow []netip.Prefix
	// EgressAllowHTTP permits plain http addresses for bots (development).
	EgressAllowHTTP bool

	// Files: an S3-compatible object store; without an endpoint, files are off.
	S3Endpoint  string
	S3Region    string
	S3Bucket    string
	S3AccessKey string
	S3SecretKey string
	// S3UploadURL is where browsers post uploads (default: the app's origin
	// and the bucket as path, served by the proxy).
	S3UploadURL string
	// FilesMaxSize is the largest file in bytes.
	FilesMaxSize int64
	// ClamAVAddr is a clamd TCP address (host:port) to scan files; empty: no scan.
	ClamAVAddr string
}

// MaxChannelName is the longest channel name in characters.
const MaxChannelName = 80

// LookupFunc matches os.LookupEnv; tests inject their own.
type LookupFunc func(key string) (string, bool)

// ReadFileFunc matches os.ReadFile; tests inject their own.
type ReadFileFunc func(name string) ([]byte, error)

// FromEnv loads the configuration from the process environment. With serve
// set, the settings only the HTTP server needs (public URL, OIDC client,
// sessions) are validated too; migrations run without them.
func FromEnv(serve bool) (Config, error) {
	if serve {
		return LoadServe(os.LookupEnv, os.ReadFile)
	}
	return Load(os.LookupEnv, os.ReadFile)
}

// Load builds a Config using the given lookup functions and validates the
// settings shared by all commands. All problems are reported together.
func Load(lookup LookupFunc, readFile ReadFileFunc) (Config, error) {
	return load(lookup, readFile, false)
}

// LoadServe is Load plus validation of the settings of the HTTP server.
func LoadServe(lookup LookupFunc, readFile ReadFileFunc) (Config, error) {
	return load(lookup, readFile, true)
}

func load(lookup LookupFunc, readFile ReadFileFunc, serve bool) (Config, error) {
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
	cfg.DrainDelay = l.duration("CENACLE_DRAIN_DELAY", 0)
	cfg.MetricsAddr = strings.TrimSpace(l.str("CENACLE_METRICS_ADDR", ""))
	cfg.PublicURL = l.origin("CENACLE_PUBLIC_URL", "http://localhost:15173", true)
	cfg.TrustProxy = l.boolean("CENACLE_TRUST_PROXY", false)
	cfg.OIDCIssuer = l.str("CENACLE_OIDC_ISSUER", "http://localhost:8190")
	cfg.OIDCBackchannelURL = l.origin("CENACLE_OIDC_BACKCHANNEL_URL", "", false)
	cfg.OIDCClientID = l.str("CENACLE_OIDC_CLIENT_ID", "cenacle-chat")
	cfg.OIDCClientSecret = l.str("CENACLE_OIDC_CLIENT_SECRET", "")
	cfg.SessionIdleTimeout = l.duration("CENACLE_SESSION_IDLE_TIMEOUT", 7*24*time.Hour)
	cfg.SessionMaxAge = l.duration("CENACLE_SESSION_MAX_AGE", 30*24*time.Hour)
	cfg.AdminEmail = strings.TrimSpace(l.str("CENACLE_ADMIN_EMAIL", ""))
	cfg.AnnouncementChannel = strings.TrimSpace(l.str("CENACLE_ANNOUNCEMENT_CHANNEL", "Central"))
	if allow, err := egress.ParseAllow(l.str("CENACLE_EGRESS_ALLOW", "")); err != nil {
		l.fail("CENACLE_EGRESS_ALLOW: %v", err)
	} else {
		cfg.EgressAllow = allow
	}
	cfg.EgressAllowHTTP = l.boolean("CENACLE_EGRESS_ALLOW_HTTP", false)
	cfg.S3Endpoint = strings.TrimSpace(l.str("CENACLE_S3_ENDPOINT", ""))
	cfg.S3Region = l.str("CENACLE_S3_REGION", "garage")
	cfg.S3Bucket = l.str("CENACLE_S3_BUCKET", "cenacle-files")
	cfg.S3AccessKey = l.str("CENACLE_S3_ACCESS_KEY", "")
	cfg.S3SecretKey = l.str("CENACLE_S3_SECRET_KEY", "")
	cfg.S3UploadURL = strings.TrimSpace(l.str("CENACLE_S3_UPLOAD_URL", ""))
	if mb, err := strconv.Atoi(l.str("CENACLE_FILES_MAX_SIZE_MB", "100")); err != nil || mb < 1 || mb > 10240 {
		l.fail("CENACLE_FILES_MAX_SIZE_MB: a number of megabytes from 1 to 10240")
	} else {
		cfg.FilesMaxSize = int64(mb) << 20
	}
	cfg.ClamAVAddr = strings.TrimSpace(l.str("CENACLE_CLAMAV_ADDR", ""))
	for _, name := range strings.Split(l.str("CENACLE_DEFAULT_CHANNELS", "General"), ",") {
		if name = strings.TrimSpace(name); name != "" {
			cfg.DefaultChannels = append(cfg.DefaultChannels, name)
		}
	}

	if cfg.LogFormat == "" {
		cfg.LogFormat = "json"
		if cfg.Env == "development" {
			cfg.LogFormat = "text"
		}
	}

	l.validate(&cfg)
	if serve {
		l.validateServe(&cfg)
	}
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

func (l *loader) boolean(key string, def bool) bool {
	switch raw := l.str(key, ""); raw {
	case "":
		return def
	case "true", "1":
		return true
	case "false", "0":
		return false
	default:
		l.fail("%s: must be true or false, got %q", key, raw)
		return def
	}
}

// origin parses an absolute http(s) URL without path, query or fragment.
// An empty optional value yields nil.
func (l *loader) origin(key, def string, required bool) *url.URL {
	raw := strings.TrimRight(l.str(key, def), "/")
	if raw == "" {
		if required {
			l.fail("%s: required", key)
		}
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		l.fail("%s: must be an http(s) origin such as https://chat.example.com, got %q", key, raw)
		return nil
	}
	return u
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

func (l *loader) validateServe(cfg *Config) {
	if cfg.S3Endpoint != "" {
		if u, err := url.Parse(cfg.S3Endpoint); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			l.fail("CENACLE_S3_ENDPOINT: must be an http(s) URL, got %q", cfg.S3Endpoint)
		}
		if cfg.S3AccessKey == "" || cfg.S3SecretKey == "" {
			l.fail("CENACLE_S3_ACCESS_KEY and CENACLE_S3_SECRET_KEY are required with CENACLE_S3_ENDPOINT")
		}
		if cfg.S3Bucket == "" {
			l.fail("CENACLE_S3_BUCKET: must not be empty")
		}
	}
	if u, err := url.Parse(cfg.OIDCIssuer); err != nil || (u.Scheme != "http" && u.Scheme != "https") ||
		u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		l.fail("CENACLE_OIDC_ISSUER: must be an http(s) URL, got %q", cfg.OIDCIssuer)
	} else if cfg.Env == "production" && u.Scheme != "https" {
		l.fail("CENACLE_OIDC_ISSUER: must use https in production")
	}
	if cfg.OIDCClientID == "" {
		l.fail("CENACLE_OIDC_CLIENT_ID: required")
	}
	if cfg.OIDCClientSecret == "" {
		l.fail("CENACLE_OIDC_CLIENT_SECRET: required")
	}
	if cfg.Env == "production" && cfg.PublicURL != nil && cfg.PublicURL.Scheme != "https" {
		l.fail("CENACLE_PUBLIC_URL: must use https in production")
	}
	if cfg.AdminEmail != "" && !strings.Contains(cfg.AdminEmail, "@") {
		l.fail("CENACLE_ADMIN_EMAIL: must be an e-mail address, got %q", cfg.AdminEmail)
	}
	seen := map[string]bool{}
	for _, name := range append([]string{cfg.AnnouncementChannel}, cfg.DefaultChannels...) {
		if name == "" {
			continue
		}
		if utf8.RuneCountInString(name) > MaxChannelName || strings.ContainsFunc(name, unicode.IsControl) {
			l.fail("channel name %q: at most %d characters, no control characters", name, MaxChannelName)
		}
		if key := strings.ToLower(name); seen[key] {
			l.fail("channel %q is configured twice (CENACLE_ANNOUNCEMENT_CHANNEL, CENACLE_DEFAULT_CHANNELS)", name)
		} else {
			seen[key] = true
		}
	}
	if cfg.SessionIdleTimeout > cfg.SessionMaxAge {
		l.fail("CENACLE_SESSION_IDLE_TIMEOUT: must not exceed CENACLE_SESSION_MAX_AGE")
	}
}
