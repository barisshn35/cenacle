// SPDX-License-Identifier: Apache-2.0

// Command server is the Cenacle chat backend.
//
// Usage:
//
//	server serve            run the HTTP server
//	server migrate up       apply all pending migrations
//	server migrate down     roll back the latest migration
//	server migrate status   list migrations and their state
//	server version          print the build version
//	server healthcheck      probe /healthz (for container health checks)
package main

import (
	"archive/zip"
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/barisshn35/cenacle/server/internal/admin"
	"github.com/barisshn35/cenacle/server/internal/app"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/cache"
	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/clamav"
	"github.com/barisshn35/cenacle/server/internal/config"
	"github.com/barisshn35/cenacle/server/internal/db"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/groups"
	"github.com/barisshn35/cenacle/server/internal/health"
	"github.com/barisshn35/cenacle/server/internal/importer"
	"github.com/barisshn35/cenacle/server/internal/jobs"
	"github.com/barisshn35/cenacle/server/internal/logging"
	"github.com/barisshn35/cenacle/server/internal/realtime"
	"github.com/barisshn35/cenacle/server/internal/storage"
	"github.com/barisshn35/cenacle/server/internal/store"
	"github.com/barisshn35/cenacle/server/internal/telemetry"
	"github.com/barisshn35/cenacle/server/migrations"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `usage: server <command>

commands:
  serve            run the HTTP server
  migrate up       apply all pending migrations
  migrate down     roll back the latest migration
  migrate status   list migrations and their state
  status           check the dependencies and summarize the installation (JSON)
  support-bundle [file|-]
                   write a support bundle (.tar.gz: status, settings without
                   secrets, runtime; no messages or people) to file or stdout
  import mattermost <export.jsonl> [dm-workspace]
                   import a Mattermost bulk export (teams become workspaces;
                   direct messages go to dm-workspace, default the first team)
  import slack <export.zip> <workspace>
                   import a Slack export into a workspace (created if missing)
  healthcheck      probe /healthz of the local server
  version          print the build version`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "healthcheck":
		// Distroless images have no curl; the binary probes itself.
		// Only CENACLE_HTTP_ADDR is read, so a broken config cannot hide liveness.
		return healthcheck(os.Getenv("CENACLE_HTTP_ADDR"))
	case "serve", "migrate", "status", "support-bundle", "import":
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}

	cfg, err := config.FromEnv(args[0] == "serve")
	if err != nil {
		return err
	}
	log := logging.New(os.Stdout, cfg.LogFormat, cfg.LogLevel).With("build", version)
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch args[0] {
	case "migrate":
		if len(args) != 2 {
			return errors.New(usage)
		}
		return migrate(ctx, cfg, log, args[1])
	case "status", "support-bundle":
		return operate(ctx, cfg, args)
	case "import":
		return importExport(ctx, cfg, log, args[1:])
	}
	return serve(ctx, cfg, log)
}

func serve(signals context.Context, cfg config.Config, log *slog.Logger) error {
	// The app keeps running for the drain delay after a signal; then ctx ends.
	ctx, cancelApp := context.WithCancel(context.WithoutCancel(signals))
	defer cancelApp()

	stopTracing, err := telemetry.SetupTracing(ctx, "cenacle-server", version, log)
	if err != nil {
		return fmt.Errorf("tracing: %w", err)
	}
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = stopTracing(flushCtx)
	}()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	telemetry.RegisterPool(pool)

	valkey := cache.New(cfg.ValkeyAddr, cfg.ValkeyPassword)
	defer valkey.Close()

	// Log the database clock once at startup as a smoke test of the sqlc
	// layer; failure is not fatal because /readyz reports it.
	if now, err := store.New(pool).ServerTime(ctx); err == nil {
		log.Info("database reachable", "db_time", now.UTC())
	} else {
		log.Warn("database not reachable at startup", "error", err)
	}

	queries := store.New(pool)
	idpClient, err := auth.NewHTTPClient(cfg.OIDCIssuer, cfg.OIDCBackchannelURL)
	if err != nil {
		return err
	}
	sessions := &auth.Sessions{Queries: queries, IdleTimeout: cfg.SessionIdleTimeout, MaxAge: cfg.SessionMaxAge}

	eventLog := &events.Log{Valkey: valkey, Key: "cenacle:events", MaxLen: 10_000}
	ephemeral := &events.Ephemeral{Valkey: valkey, Channel: "cenacle:ephemeral"}
	hub := &realtime.Hub{Log: eventLog, Ephemeral: ephemeral, Logger: log}
	go hub.Run(ctx)
	go hub.RunEphemeral(ctx)
	go (&events.Relay{Pool: pool, Log: eventLog, Logger: log}).Run(ctx)
	presence := &realtime.Presence{
		Valkey: valkey, Ephemeral: ephemeral, Workspaces: realtime.WorkspacesOf(queries), Log: log,
		Offline: func(ctx context.Context, user pgtype.UUID) { _ = queries.SetLastSeen(ctx, user) },
	}
	go presence.RunSweeper(ctx, 10*time.Second)
	cookies := auth.NewCookies(cfg.PublicURL)
	auditLog := &audit.Log{Queries: queries, Logger: log}
	go chat.RunEnsureDefaults(ctx, queries, chat.Defaults{
		Announcement: cfg.AnnouncementChannel, Channels: cfg.DefaultChannels, AdminEmail: cfg.AdminEmail,
	}, log)

	// Requests to bots (slash commands, event deliveries) never reach private
	// networks unless the operator allows them.
	// Files: an S3-compatible object store, when configured.
	files := chat.NewFiles(nil, nil, 0)
	var maxFileSize int64 // 0: files are off
	var draining atomic.Bool
	checkers := []health.Checker{db.Checker{Pool: pool}, valkey, health.CheckFunc{
		CheckName: "drain",
		Fn: func(context.Context) error {
			if draining.Load() {
				return errors.New("shutting down")
			}
			return nil
		},
	}}
	if cfg.S3Endpoint != "" {
		objects, err := storage.New(storage.Config{
			Endpoint: cfg.S3Endpoint, Region: cfg.S3Region, Bucket: cfg.S3Bucket,
			AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey,
			UploadURL: cmp.Or(cfg.S3UploadURL, strings.TrimSuffix(cfg.PublicURL.String(), "/")+"/"+cfg.S3Bucket+"/"),
		})
		if err != nil {
			return err
		}
		var scanner *clamav.Scanner
		if cfg.ClamAVAddr != "" {
			scanner = &clamav.Scanner{Addr: cfg.ClamAVAddr}
		}
		files = chat.NewFiles(objects, scanner, cfg.FilesMaxSize)
		maxFileSize = cfg.FilesMaxSize
		checkers = append(checkers, objects)
	}

	egressClient := egress.New(egress.Policy{
		Allow: cfg.EgressAllow, AllowHTTP: cfg.EgressAllowHTTP, Timeout: 10 * time.Second, MaxResponse: 1 << 20,
	})

	// Background jobs; River's tables come with `migrate up`.
	background := &chat.Background{DB: pool, Queries: queries, Egress: egressClient, Files: files, Log: log}
	jobClient, err := jobs.NewClient(pool, jobs.Deps{
		Purger: chat.Purger{Queries: queries}, Sessions: sessions, Log: log,
		Integrations: background,
		Profiles:     background,
		Directory: &groups.Feed{
			HTTP: idpClient, Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClientID, ClientSecret: cfg.OIDCClientSecret,
			DB: pool, Queries: queries, Ephemeral: ephemeral, AdminEmail: cfg.AdminEmail, Log: log,
		},
	})
	if err != nil {
		return err
	}
	if err := jobClient.Start(ctx); err != nil {
		return fmt.Errorf("start jobs (did `migrate up` run?): %w", err)
	}

	handler := app.NewRouter(app.Deps{
		Log:          log,
		Checkers:     checkers,
		ReadyTimeout: cfg.ReadyTimeout,
		Auth: &auth.Handlers{
			IdP: &auth.IdentityProvider{
				Issuer:       cfg.OIDCIssuer,
				ClientID:     cfg.OIDCClientID,
				ClientSecret: cfg.OIDCClientSecret,
				RedirectURL:  cfg.PublicURL.String() + "/api/auth/callback",
				HTTPClient:   idpClient,
			},
			Sessions:    sessions,
			Users:       queries,
			Flows:       valkey,
			Cookies:     cookies,
			PublicURL:   cfg.PublicURL,
			TrustProxy:  cfg.TrustProxy,
			AdminEmail:  cfg.AdminEmail,
			Audit:       auditLog,
			Ephemeral:   ephemeral,
			MaxFileSize: maxFileSize,
			Log:         log,
		},
		Chat: &chat.Handlers{
			Queries:           queries,
			DB:                pool,
			Egress:            egressClient,
			Files:             files,
			AdminEmail:        cfg.AdminEmail,
			PublicURL:         cfg.PublicURL.String(),
			AccountURL:        auth.AccountURL(cfg.OIDCIssuer, cfg.PublicURL.String()),
			Ephemeral:         ephemeral,
			Audit:             auditLog,
			Limiter:           valkey,
			Cookies:           cookies,
			Log:               log,
			Configured:        append([]string{cfg.AnnouncementChannel}, cfg.DefaultChannels...),
			MessagesPerWindow: 20,
			Window:            10 * time.Second,
		},
		Realtime: &realtime.Handler{
			Hub:       hub,
			Tickets:   valkey,
			Sessions:  sessions,
			Members:   queries,
			Presence:  presence,
			Cookies:   cookies,
			PublicURL: cfg.PublicURL,
			Settings:  realtime.DefaultSettings,
			Log:       log,
		},
	})
	if telemetry.TracingEnabled() {
		handler = otelhttp.NewHandler(handler, "http")
	}
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	errCh := make(chan error, 2)
	go func() {
		log.Info("http server listening", "addr", cfg.HTTPAddr, "env", cfg.Env)
		errCh <- srv.ListenAndServe()
	}()
	if cfg.MetricsAddr != "" {
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", telemetry.Handler())
		metrics := &http.Server{Addr: cfg.MetricsAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		go func() {
			log.Info("metrics listening", "addr", cfg.MetricsAddr)
			errCh <- metrics.ListenAndServe()
		}()
		defer func() { _ = metrics.Close() }()
	}

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	case <-signals.Done():
	}

	// Rolling upgrades: fail /readyz first so the load balancer moves away,
	// keep serving meanwhile, then stop.
	if cfg.DrainDelay > 0 {
		draining.Store(true)
		log.Info("draining", "delay", cfg.DrainDelay)
		time.Sleep(cfg.DrainDelay)
	}
	cancelApp()
	log.Info("shutting down", "timeout", cfg.ShutdownTimeout)
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := jobClient.Stop(stopCtx); err != nil {
			log.Warn("stopping jobs", "error", err)
		}
	}()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	log.Info("shutdown complete")
	return nil
}

// importExport reads another chat's export into Cenacle.
func importExport(ctx context.Context, cfg config.Config, log *slog.Logger, args []string) error {
	if len(args) < 2 {
		return errors.New(usage)
	}
	var data importer.Data
	switch args[0] {
	case "mattermost":
		f, err := os.Open(args[1]) //nolint:gosec // the operator names the export to read
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		dmWorkspace := ""
		if len(args) > 2 {
			dmWorkspace = args[2]
		}
		if data, err = importer.ReadMattermost(f, dmWorkspace); err != nil {
			return fmt.Errorf("reading the export: %w", err)
		}
	case "slack":
		if len(args) < 3 {
			return errors.New("import slack needs the export and a workspace name\n\n" + usage)
		}
		zr, err := zip.OpenReader(args[1])
		if err != nil {
			return err
		}
		defer func() { _ = zr.Close() }()
		if data, err = importer.ReadSlack(&zr.Reader, args[2]); err != nil {
			return fmt.Errorf("reading the export: %w", err)
		}
	default:
		return fmt.Errorf("unknown export %q (mattermost or slack)\n\n%s", args[0], usage)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	log.Info("import starting", "people", len(data.Users), "channels", len(data.Channels), "messages", len(data.Messages))
	res, err := importer.Import(ctx, pool, data, log)
	if err != nil {
		return err
	}
	log.Info("import finished", "result", res.String())
	return nil
}

// operate runs the status and support-bundle commands.
func operate(ctx context.Context, cfg config.Config, args []string) error {
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	valkey := cache.New(cfg.ValkeyAddr, cfg.ValkeyPassword)
	defer valkey.Close()
	checks := []health.Checker{db.Checker{Pool: pool}, valkey}
	if cfg.S3Endpoint != "" {
		objects, err := storage.New(storage.Config{Endpoint: cfg.S3Endpoint, Region: cfg.S3Region, Bucket: cfg.S3Bucket,
			AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey})
		if err != nil {
			return err
		}
		checks = append(checks, objects)
	}
	migration := func(ctx context.Context) (int64, error) {
		sqlDB := stdlib.OpenDBFromPool(pool)
		defer func() { _ = sqlDB.Close() }()
		provider, err := newMigrator(sqlDB)
		if err != nil {
			return 0, err
		}
		return provider.GetDBVersion(ctx)
	}
	report := admin.Status(ctx, version, store.New(pool), migration, checks)
	if args[0] == "status" {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	name := "cenacle-support-" + report.Time.Format("20060102-150405") + ".tar.gz"
	if len(args) > 1 {
		name = args[1]
	}
	if name == "-" {
		return admin.WriteBundle(os.Stdout, report, admin.Settings(cfg))
	}
	f, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // the operator names the file
	if err != nil {
		return err
	}
	if err := admin.WriteBundle(f, report, admin.Settings(cfg)); err != nil {
		_ = f.Close()
		return err
	}
	fmt.Fprintln(os.Stderr, "wrote", name)
	return f.Close()
}

func migrate(ctx context.Context, cfg config.Config, log *slog.Logger, cmd string) error {
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()

	provider, err := newMigrator(sqlDB)
	if err != nil {
		return err
	}

	switch cmd {
	case "up":
		results, err := provider.Up(ctx)
		logResults(log, results)
		if err != nil {
			return fmt.Errorf("migrate up: %w", err)
		}
		if len(results) == 0 {
			log.Info("no pending migrations")
		}
		return jobs.Migrate(ctx, pool, log)
	case "down":
		res, err := provider.Down(ctx)
		if err != nil {
			return fmt.Errorf("migrate down: %w", err)
		}
		logResults(log, []*goose.MigrationResult{res})
		return nil
	case "status":
		statuses, err := provider.Status(ctx)
		if err != nil {
			return fmt.Errorf("migrate status: %w", err)
		}
		for _, s := range statuses {
			log.Info("migration", "version", s.Source.Version, "file", s.Source.Path, "state", s.State, "applied_at", s.AppliedAt)
		}
		return nil
	default:
		return fmt.Errorf("unknown migrate command %q\n\n%s", cmd, usage)
	}
}

// newMigrator returns a goose provider guarded by a PostgreSQL advisory lock,
// so concurrently starting replicas never apply migrations twice.
func newMigrator(sqlDB *sql.DB) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, fmt.Errorf("migration lock: %w", err)
	}
	return goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS,
		goose.WithSessionLocker(locker))
}

func logResults(log *slog.Logger, results []*goose.MigrationResult) {
	for _, r := range results {
		if r == nil {
			continue
		}
		log.Info("migration applied", "version", r.Source.Version, "file", r.Source.Path,
			"direction", r.Direction, "duration", r.Duration, "error", r.Error)
	}
}

func healthcheck(addr string) error {
	if addr == "" {
		addr = ":8180"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("CENACLE_HTTP_ADDR: %w", err)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("CENACLE_HTTP_ADDR: invalid port %q", port)
	}
	client := &http.Client{Timeout: 3 * time.Second}
	// Fixed loopback host and a validated numeric port: no request forgery possible.
	res, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/healthz") //nolint:gosec,noctx // see above
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %d", res.StatusCode)
	}
	return nil
}
