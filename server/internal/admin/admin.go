// SPDX-License-Identifier: AGPL-3.0-only

// Package admin holds operator tools of the server binary: an instance status
// report and a support bundle (status, redacted settings, runtime). Bundles
// contain no messages, names, addresses or secrets.
package admin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/fips140"
	"encoding/json"
	"io"
	"net/url"
	"runtime"
	"sort"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/config"
	"github.com/Cenacle-TR/cenacle/server/internal/health"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// Report describes an installation at one moment.
type Report struct {
	Version string `json:"version"`
	// FIPS140 is set when the server runs in FIPS 140-3 mode (the Go
	// Cryptographic Module: a FIPS build, or GODEBUG=fips140=on).
	FIPS140    bool                     `json:"fips140"`
	Time       time.Time                `json:"time"`
	Checks     map[string]string        `json:"checks"`
	Migration  int64                    `json:"migration"`
	Counts     *store.InstanceCountsRow `json:"counts,omitempty"`
	CountError string                   `json:"count_error,omitempty"`
}

// Status checks the dependencies and counts what the installation holds.
func Status(ctx context.Context, version string, q store.Querier, migration func(context.Context) (int64, error), checks []health.Checker) Report {
	r := Report{Version: version, FIPS140: fips140.Enabled(), Time: time.Now().UTC(), Checks: map[string]string{}}
	for _, c := range checks {
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		if err := c.Check(cctx); err != nil {
			r.Checks[c.Name()] = "unavailable: " + err.Error()
		} else {
			r.Checks[c.Name()] = "ok"
		}
		cancel()
	}
	if v, err := migration(ctx); err == nil {
		r.Migration = v
	}
	counts, err := q.InstanceCounts(ctx)
	if err != nil {
		r.CountError = err.Error()
	} else {
		r.Counts = &counts
	}
	return r
}

// Settings returns the configuration with secrets replaced by "set" or "".
func Settings(c config.Config) map[string]any {
	secret := func(v string) string {
		if v == "" {
			return ""
		}
		return "set"
	}
	db := ""
	if u, err := url.Parse(c.DatabaseURL); err == nil {
		db = u.Scheme + "://" + u.Host + u.Path // no user or password
	}
	issuer := c.OIDCIssuer
	public := ""
	if c.PublicURL != nil {
		public = c.PublicURL.String()
	}
	allow := make([]string, 0, len(c.EgressAllow))
	for _, p := range c.EgressAllow {
		allow = append(allow, p.String())
	}
	return map[string]any{
		"env": c.Env, "log_level": c.LogLevel.String(), "log_format": c.LogFormat,
		"public_url": public, "trust_proxy": c.TrustProxy,
		"database": db, "valkey_addr": c.ValkeyAddr, "valkey_password": secret(c.ValkeyPassword),
		"oidc_issuer": issuer, "oidc_client_id": c.OIDCClientID, "oidc_client_secret": secret(c.OIDCClientSecret),
		"session_idle_timeout": limitText(c.SessionIdleTimeout), "session_max_age": limitText(c.SessionMaxAge),
		"admin_email": secret(c.AdminEmail), "announcement_channel": c.AnnouncementChannel,
		"default_channels": c.DefaultChannels, "egress_allow": allow, "egress_allow_http": c.EgressAllowHTTP,
		"s3_endpoint": c.S3Endpoint, "s3_bucket": c.S3Bucket, "s3_region": c.S3Region,
		"s3_access_key": secret(c.S3AccessKey), "s3_secret_key": secret(c.S3SecretKey),
		"files_max_size": c.FilesMaxSize, "clamav": c.ClamAVAddr != "",
		"metrics_addr": c.MetricsAddr, "drain_delay": c.DrainDelay.String(),
		"shutdown_timeout": c.ShutdownTimeout.String(),
	}
}

// Runtime describes the process.
func Runtime() map[string]any {
	return map[string]any{"go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "cpus": runtime.NumCPU()}
}

// WriteBundle writes a gzip-compressed tar with the report, the redacted
// settings and the runtime.
func WriteBundle(w io.Writer, r Report, settings map[string]any) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	files := map[string]any{"status.json": r, "settings.json": settings, "runtime.json": Runtime()}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetIndent("", "  ")
		if err := enc.Encode(files[name]); err != nil {
			return err
		}
		if err := tw.WriteHeader(&tar.Header{Name: "cenacle-support/" + name, Mode: 0o644, Size: int64(buf.Len()), ModTime: r.Time}); err != nil {
			return err
		}
		if _, err := tw.Write(buf.Bytes()); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// limitText shows a time limit, or "none" when there is no limit.
func limitText(d time.Duration) string {
	if d <= 0 {
		return "none"
	}
	return d.String()
}
