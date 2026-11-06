// SPDX-License-Identifier: AGPL-3.0-only

// Package config loads and validates the chat server configuration.
//
// Configuration comes from environment variables prefixed with CENACLE_.
// Every variable can alternatively be read from a file by setting
// <NAME>_FILE to a path, which is how Docker/Compose secrets are consumed.
// Setting both <NAME> and <NAME>_FILE is an error unless one of them is
// empty (compose passes unset settings as "" and mounts empty secret files).
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Cenacle-TR/cenacle/server/internal/egress"
)

// DefaultSourceURL is the source code of Cenacle as released.
const DefaultSourceURL = "https://github.com/Cenacle-TR/cenacle"

// Config is the validated server configuration.
type Config struct {
	Calls *Calls
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
	// DatabaseMaxConns is the most connections one server keeps (busy
	// instances wait less with more; mind PostgreSQL's max_connections).
	DatabaseMaxConns int32
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

	// SessionIdleTimeout ends sessions that were not used for this long; 0:
	// no limit (the default since v0.29: signed in until signing out).
	SessionIdleTimeout time.Duration
	// SessionMaxAge ends sessions this long after sign-in, used or not; 0: no limit.
	SessionMaxAge time.Duration
	// AuditRetention, AIRequestRetention and LinkPreviewRetention delete audit
	// events, records of AI requests and link previews this old; 0: kept.
	AuditRetention, AIRequestRetention, LinkPreviewRetention time.Duration

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
	// LinkPreviews: the server fetches a preview of the first link of messages
	// (public addresses only; never through EgressAllow).
	LinkPreviews bool
	// WebApp, when set, decides whether people may use Cenacle in web
	// browsers and overrides the administrators' setting (recovery when
	// the administrators locked themselves out). nil leaves it to them.
	WebApp *bool
	// DesktopMinVersion is the oldest desktop app the server accepts ("" any).
	DesktopMinVersion string
	// PrivacyURL is the operator's privacy policy, linked from the apps; optional.
	PrivacyURL string
	// SourceURL is where people get the source code of the server they use
	// (AGPL-3.0 section 13): an installation that changes Cenacle points it
	// at its own changed source.
	SourceURL string

	// FilesBackend keeps files: "s3" (an S3-compatible object store), "azure"
	// (Azure Blob Storage) or "dir" (a directory); "" turns files off.
	FilesBackend string
	// S3: an S3-compatible object store.
	S3Endpoint  string
	S3Region    string
	S3Bucket    string
	S3AccessKey string
	S3SecretKey string
	// S3UploadURL is where browsers post uploads (default: the app's origin
	// and the bucket as path, served by the proxy).
	S3UploadURL string
	// Azure Blob Storage: account, shared key, container, optional endpoint.
	AzureAccount   string
	AzureKey       string
	AzureContainer string
	AzureEndpoint  string
	// FilesDir is the directory of the "dir" backend (absolute).
	FilesDir string
	// FilesMaxSize is the largest file in bytes.
	FilesMaxSize int64
	// ClamAVAddr is a clamd TCP address (host:port) to scan files; empty: no scan.
	ClamAVAddr string

	// SMTPHost turns on e-mail (missed mentions and messages); empty: no e-mail.
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	// SMTPFrom is the sender address ("Cenacle <chat@example.com>").
	SMTPFrom string
	// SMTPSecurity is starttls (port 587), tls (port 465) or none (a local relay).
	SMTPSecurity string

	// AIURL is an OpenAI-compatible API of a model the operator runs (e.g.
	// http://ollama:11434/v1); with AIModel it turns on the optional AI
	// features, which workspaces still enable themselves. Empty: no AI at all.
	AIURL     string
	AIModel   string
	AIAPIKey  string
	AITimeout time.Duration
	// AIPolicyURL is the operator's page on how the model's server keeps
	// requests, linked from the AI notice people accept; optional.
	AIPolicyURL string
	// WebPush turns on web push (through the browsers' push services).
	WebPush bool
	// WebPushSubject is the contact the push services see (mailto: or https:).
	WebPushSubject string
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
	if n, err := strconv.Atoi(l.str("CENACLE_DATABASE_MAX_CONNS", "25")); err != nil || n < 2 || n > 500 {
		l.fail("CENACLE_DATABASE_MAX_CONNS: a number of connections from 2 to 500")
	} else {
		cfg.DatabaseMaxConns = int32(n) //nolint:gosec // checked above
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
	cfg.SessionIdleTimeout = l.limit("CENACLE_SESSION_IDLE_TIMEOUT")
	cfg.SessionMaxAge = l.limit("CENACLE_SESSION_MAX_AGE")
	cfg.AuditRetention = l.limit("CENACLE_AUDIT_RETENTION")
	cfg.AIRequestRetention = l.limit("CENACLE_AI_REQUEST_RETENTION")
	cfg.LinkPreviewRetention = l.limit("CENACLE_LINK_PREVIEW_RETENTION")
	cfg.AdminEmail = strings.TrimSpace(l.str("CENACLE_ADMIN_EMAIL", ""))
	cfg.AnnouncementChannel = strings.TrimSpace(l.str("CENACLE_ANNOUNCEMENT_CHANNEL", "Central"))
	if allow, err := egress.ParseAllow(l.str("CENACLE_EGRESS_ALLOW", "")); err != nil {
		l.fail("CENACLE_EGRESS_ALLOW: %v", err)
	} else {
		cfg.EgressAllow = allow
	}
	cfg.EgressAllowHTTP = l.boolean("CENACLE_EGRESS_ALLOW_HTTP", false)
	cfg.LinkPreviews = l.boolean("CENACLE_LINK_PREVIEWS", true)
	cfg.WebApp = l.onOff("CENACLE_WEB_APP")
	cfg.DesktopMinVersion = strings.TrimSpace(l.str("CENACLE_DESKTOP_MIN_VERSION", ""))
	cfg.PrivacyURL = strings.TrimSpace(l.str("CENACLE_PRIVACY_URL", ""))
	if cfg.PrivacyURL != "" {
		if u, err := url.Parse(cfg.PrivacyURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			l.fail("CENACLE_PRIVACY_URL: an http(s) address")
		}
	}
	cfg.SourceURL = strings.TrimSpace(l.str("CENACLE_SOURCE_URL", DefaultSourceURL))
	if u, err := url.Parse(cfg.SourceURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		l.fail("CENACLE_SOURCE_URL: an http(s) address")
	}
	if v := cfg.DesktopMinVersion; v != "" && !semver.MatchString(v) {
		l.fail("CENACLE_DESKTOP_MIN_VERSION: must be a version such as 0.30.0, got %q", v)
	}
	cfg.S3Endpoint = strings.TrimSpace(l.str("CENACLE_S3_ENDPOINT", ""))
	cfg.S3Region = l.str("CENACLE_S3_REGION", "garage")
	cfg.S3Bucket = l.str("CENACLE_S3_BUCKET", "cenacle-files")
	cfg.S3AccessKey = l.str("CENACLE_S3_ACCESS_KEY", "")
	cfg.S3SecretKey = l.str("CENACLE_S3_SECRET_KEY", "")
	cfg.S3UploadURL = strings.TrimSpace(l.str("CENACLE_S3_UPLOAD_URL", ""))
	cfg.AzureAccount = strings.TrimSpace(l.str("CENACLE_AZURE_ACCOUNT", ""))
	cfg.AzureKey = strings.TrimSpace(l.str("CENACLE_AZURE_KEY", ""))
	cfg.AzureContainer = strings.TrimSpace(l.str("CENACLE_AZURE_CONTAINER", "cenacle-files"))
	cfg.AzureEndpoint = strings.TrimSpace(l.str("CENACLE_AZURE_ENDPOINT", ""))
	cfg.FilesDir = strings.TrimSpace(l.str("CENACLE_FILES_DIR", ""))
	// Without a choice (unset or empty, as compose passes it), an S3 endpoint
	// turns S3 on (as before 0.38); "off" turns files off.
	cfg.FilesBackend = strings.TrimSpace(l.str("CENACLE_FILES_BACKEND", ""))
	if cfg.FilesBackend == "" && cfg.S3Endpoint != "" {
		cfg.FilesBackend = "s3"
	}
	switch cfg.FilesBackend {
	case "", "s3", "azure", "dir":
	case "off":
		cfg.FilesBackend = ""
	default:
		l.fail("CENACLE_FILES_BACKEND: s3, azure, dir or off, got %q", cfg.FilesBackend)
	}
	if mb, err := strconv.Atoi(l.str("CENACLE_FILES_MAX_SIZE_MB", "100")); err != nil || mb < 1 || mb > 10240 {
		l.fail("CENACLE_FILES_MAX_SIZE_MB: a number of megabytes from 1 to 10240")
	} else {
		cfg.FilesMaxSize = int64(mb) << 20
	}
	cfg.ClamAVAddr = strings.TrimSpace(l.str("CENACLE_CLAMAV_ADDR", ""))
	cfg.SMTPHost = strings.TrimSpace(l.str("CENACLE_SMTP_HOST", ""))
	if port, err := strconv.Atoi(l.str("CENACLE_SMTP_PORT", "587")); err != nil || port < 1 || port > 65535 {
		l.fail("CENACLE_SMTP_PORT: a port number")
	} else {
		cfg.SMTPPort = port
	}
	cfg.SMTPUsername = l.str("CENACLE_SMTP_USERNAME", "")
	cfg.SMTPPassword = l.str("CENACLE_SMTP_PASSWORD", "")
	cfg.SMTPFrom = strings.TrimSpace(l.str("CENACLE_SMTP_FROM", ""))
	cfg.SMTPSecurity = l.str("CENACLE_SMTP_SECURITY", "starttls")
	switch cfg.SMTPSecurity {
	case "starttls", "tls", "none":
	default:
		l.fail("CENACLE_SMTP_SECURITY: starttls, tls or none")
	}
	if cfg.SMTPHost != "" && cfg.SMTPFrom == "" {
		l.fail("CENACLE_SMTP_FROM: the sender address is needed with CENACLE_SMTP_HOST")
	}
	cfg.AIURL = strings.TrimRight(strings.TrimSpace(l.str("CENACLE_AI_URL", "")), "/")
	cfg.AIModel = strings.TrimSpace(l.str("CENACLE_AI_MODEL", ""))
	cfg.AIAPIKey = l.str("CENACLE_AI_API_KEY", "")
	cfg.AITimeout = l.duration("CENACLE_AI_TIMEOUT", 2*time.Minute)
	if cfg.AIURL != "" {
		if u, err := url.Parse(cfg.AIURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			l.fail("CENACLE_AI_URL: an http(s) address of an OpenAI-compatible API")
		}
		if cfg.AIModel == "" {
			l.fail("CENACLE_AI_MODEL: the model to use is needed with CENACLE_AI_URL")
		}
	}
	cfg.AIPolicyURL = strings.TrimSpace(l.str("CENACLE_AI_POLICY_URL", ""))
	if cfg.AIPolicyURL != "" {
		if u, err := url.Parse(cfg.AIPolicyURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			l.fail("CENACLE_AI_POLICY_URL: an http(s) address")
		}
	}
	cfg.WebPush = l.boolean("CENACLE_WEB_PUSH", false)
	cfg.WebPushSubject = strings.TrimSpace(l.str("CENACLE_WEB_PUSH_SUBJECT", ""))
	if cfg.WebPush && cfg.WebPushSubject == "" {
		if cfg.AdminEmail == "" {
			l.fail("CENACLE_WEB_PUSH_SUBJECT: a mailto: or https: contact is needed with CENACLE_WEB_PUSH")
		} else {
			cfg.WebPushSubject = "mailto:" + cfg.AdminEmail
		}
	}
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
		cfg.Calls = loadCalls(&l)
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
	// An empty value does not count: compose passes unset settings as "".
	case ok && val != "" && fileOK:
		// Nor does an empty file: compose mounts optional secrets (SMTP
		// password, AI key) whether used or not, so the variable may set them.
		if b, err := l.readFile(file); err == nil && strings.TrimSpace(string(b)) == "" {
			return val
		}
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

// limit reads an optional time limit: unset, "0" or "none" mean no limit (0).
func (l *loader) limit(key string) time.Duration {
	switch raw := strings.TrimSpace(l.str(key, "")); raw {
	case "", "0", "none":
		return 0
	default:
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			l.fail("%s: must be a positive duration such as 720h, or none, got %q", key, raw)
			return 0
		}
		return d
	}
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

// onOff reads an optional switch: nil when unset.
func (l *loader) onOff(key string) *bool {
	var v bool
	switch raw := strings.ToLower(strings.TrimSpace(l.str(key, ""))); raw {
	case "":
		return nil
	case "on", "true", "1":
		v = true
	case "off", "false", "0":
		v = false
	default:
		l.fail("%s: must be on or off, got %q", key, raw)
		return nil
	}
	return &v
}

// semver is a plain release version (major.minor.patch).
var semver = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

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
	switch cfg.FilesBackend {
	case "azure":
		if cfg.AzureAccount == "" || cfg.AzureKey == "" || cfg.AzureContainer == "" {
			l.fail("CENACLE_AZURE_ACCOUNT, CENACLE_AZURE_KEY and CENACLE_AZURE_CONTAINER are required with CENACLE_FILES_BACKEND=azure")
		}
		if u, err := url.Parse(cfg.AzureEndpoint); cfg.AzureEndpoint != "" &&
			(err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https")) {
			l.fail("CENACLE_AZURE_ENDPOINT: must be an http(s) URL, got %q", cfg.AzureEndpoint)
		}
	case "dir":
		if !strings.HasPrefix(cfg.FilesDir, "/") {
			l.fail("CENACLE_FILES_DIR: an absolute directory is required with CENACLE_FILES_BACKEND=dir")
		}
	case "s3":
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
	if cfg.SessionIdleTimeout > 0 && cfg.SessionMaxAge > 0 && cfg.SessionIdleTimeout > cfg.SessionMaxAge {
		l.fail("CENACLE_SESSION_IDLE_TIMEOUT: must not exceed CENACLE_SESSION_MAX_AGE")
	}
}
