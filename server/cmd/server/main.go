// SPDX-License-Identifier: AGPL-3.0-only

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
	"crypto/fips140"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
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

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"github.com/barisshn35/cenacle/server/internal/admin"
	"github.com/barisshn35/cenacle/server/internal/ai"
	"github.com/barisshn35/cenacle/server/internal/app"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/cache"
	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/clamav"
	"github.com/barisshn35/cenacle/server/internal/config"
	"github.com/barisshn35/cenacle/server/internal/db"
	"github.com/barisshn35/cenacle/server/internal/e2e"
	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/groups"
	"github.com/barisshn35/cenacle/server/internal/health"
	"github.com/barisshn35/cenacle/server/internal/importer"
	"github.com/barisshn35/cenacle/server/internal/jobs"
	"github.com/barisshn35/cenacle/server/internal/logging"
	"github.com/barisshn35/cenacle/server/internal/notify"
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
  import rocketchat <export> <workspace>
                   import a mongoexport of Rocket.Chat (users, rooms,
                   subscriptions, messages) into a workspace
  import zulip <export.tar.gz> [workspace]
                   import a Zulip organization export (default workspace:
                   the organization's name)
  import discord <export> [workspace]
                   import DiscordChatExporter JSON files (each server becomes
                   a workspace unless one is given)
  import teams <export> [workspace]
                   import Microsoft Teams messages saved from Microsoft Graph
                   (each team becomes a workspace unless one is given)
  import cenacle <export.zip>
                   import a Cenacle export (from server export) with threads,
                   reactions, pins and files
                   An <export> is a directory, a .zip or a .tar.gz. An import
                   stops if the export names workspaces or channels that exist
                   and were not created by an import; import --merge <source>
                   adds to them (people join as members, roles stay as they are).
  export <file.zip> [workspace...]
                   export workspaces (default: all of them) to move them to
                   another Cenacle server
  e2e-escrow <private-key.pem> <e-mail> [channel-id]
                   open a person's encrypted history backups with the
                   organization's escrow key (JSON lines on stdout; audited)
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
		if fips140.Enabled() {
			fmt.Println(version, "(FIPS 140-3 mode)")
		} else {
			fmt.Println(version)
		}
		return nil
	case "healthcheck":
		// Distroless images have no curl; the binary probes itself.
		// Only CENACLE_HTTP_ADDR is read, so a broken config cannot hide liveness.
		return healthcheck(os.Getenv("CENACLE_HTTP_ADDR"))
	case "serve", "migrate", "status", "support-bundle", "import", "export", "e2e-escrow":
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
	case "export":
		return exportWorkspaces(ctx, cfg, log, args[1:])
	case "e2e-escrow":
		return openEscrow(ctx, cfg, log, args[1:])
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

	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
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
	// Files: an object store, when configured.
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
	objects, uploads, err := openFiles(cfg, valkey)
	if err != nil {
		return err
	}
	if objects != nil {
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
	directory := &groups.Feed{
		HTTP: idpClient, Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClientID, ClientSecret: cfg.OIDCClientSecret,
		DB: pool, Queries: queries, Ephemeral: ephemeral, AdminEmail: cfg.AdminEmail, Log: log,
	}
	deps := jobs.Deps{
		Purger: chat.Purger{Queries: queries}, Sessions: sessions, Log: log,
		Integrations: background,
		Profiles:     background,
		Directory:    directory,
	}
	deps.Workflows = &chat.WorkflowRunner{DB: pool, Queries: queries, Egress: egressClient, Log: log}
	deps.Retention = chat.RetentionPurger{Queries: queries}
	deps.Reminders = &chat.Reminders{DB: pool, Queries: queries, Log: log}
	deps.Feeds = &chat.FeedReader{DB: pool, Queries: queries, Egress: egressClient, Log: log}
	deps.Federation = &chat.FederationSender{DB: pool, Queries: queries, Egress: egressClient, Log: log}
	deps.FileText = &chat.FileTextReader{Queries: queries, Files: files, Log: log}
	deps.Archive = &chat.ArchiveExporter{Queries: queries, Files: files, Host: cfg.PublicURL.Hostname(), Log: log}
	deps.AuditStream = &chat.AuditForwarder{Queries: queries, Egress: egressClient, Server: cfg.PublicURL.String(), Log: log}
	if cfg.LinkPreviews {
		// Anyone can post a link: no allow list, https only.
		deps.Links = &chat.LinkFetcher{
			DB: pool, Queries: queries, Log: log,
			Egress: egress.New(egress.Policy{Timeout: 5 * time.Second, MaxResponse: 2 << 20}),
		}
	}
	// Notifications outside the app: web push and e-mail, both optional.
	var pushPublicKey func(context.Context) (string, error)
	if cfg.WebPush {
		public, private, err := notify.Keys(ctx, queries)
		if err != nil {
			return fmt.Errorf("web push keys: %w", err)
		}
		pushPublicKey = func(context.Context) (string, error) { return public, nil }
		deps.Push = &notify.Pusher{
			Queries: queries, Presence: presence, Sessions: sessions, PublicURL: cfg.PublicURL.String(), Log: log,
			// Not egressClient: its allow list is for bots, endpoints come from browsers.
			Push: &notify.Push{Egress: notify.PushEgress(), Subscriber: cfg.WebPushSubject, PublicKey: public, PrivateKey: private},
		}
	}
	if cfg.SMTPHost != "" {
		deps.Email = &notify.Emailer{
			Queries: queries, Presence: presence, PublicURL: cfg.PublicURL.String(), Log: log,
			SMTP: &notify.SMTP{
				Host: cfg.SMTPHost, Port: cfg.SMTPPort, Username: cfg.SMTPUsername, Password: cfg.SMTPPassword,
				From: cfg.SMTPFrom, Security: cfg.SMTPSecurity,
			},
		}
	}
	jobClient, err := jobs.NewClient(pool, deps)
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
			Sessions:          sessions,
			Users:             queries,
			Flows:             valkey,
			Cookies:           cookies,
			PublicURL:         cfg.PublicURL,
			TrustProxy:        cfg.TrustProxy,
			AdminEmail:        cfg.AdminEmail,
			Audit:             auditLog,
			Ephemeral:         ephemeral,
			MaxFileSize:       maxFileSize,
			AI:                cfg.AIURL != "",
			WebApp:            &auth.WebApp{Store: queries, Forced: cfg.WebApp},
			DesktopMinVersion: cfg.DesktopMinVersion,
			PrivacyURL:        cfg.PrivacyURL,
			SourceURL:         cfg.SourceURL,
			GroupRenames:      directory,
			Log:               log,
		},
		Chat: &chat.Handlers{
			AI:                ai.New(cfg.AIURL, cfg.AIModel, cfg.AIAPIKey, cfg.AITimeout),
			AIPolicyURL:       cfg.AIPolicyURL,
			Queries:           queries,
			DB:                pool,
			Egress:            egressClient,
			Files:             files,
			AdminEmail:        cfg.AdminEmail,
			PublicURL:         cfg.PublicURL.String(),
			Version:           version,
			Sessions:          sessions,
			TrustProxy:        cfg.TrustProxy,
			Settings:          admin.Settings(cfg),
			AccountURL:        auth.AccountURL(cfg.OIDCIssuer, cfg.PublicURL.String()),
			EmailAvailable:    cfg.SMTPHost != "",
			PushPublicKey:     pushPublicKey,
			Ephemeral:         ephemeral,
			Audit:             auditLog,
			Limiter:           valkey,
			Replays:           valkey,
			Cookies:           cookies,
			Log:               log,
			Configured:        append([]string{cfg.AnnouncementChannel}, cfg.DefaultChannels...),
			Presence:          presence,
			LinkPreviews:      cfg.LinkPreviews,
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
		Uploads: uploads,
	})
	if telemetry.TracingEnabled() {
		handler = telemetry.TraceHandler(handler)
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

// openFiles opens the configured file store (nil when files are off) and, for
// stores browsers cannot reach, the handler that receives their uploads.
func openFiles(cfg config.Config, tickets storage.Tickets) (storage.Store, http.Handler, error) {
	uploads := strings.TrimSuffix(cfg.PublicURL.String(), "/") + app.UploadsPath
	switch cfg.FilesBackend {
	case "s3":
		s, err := storage.New(storage.Config{
			Endpoint: cfg.S3Endpoint, Region: cfg.S3Region, Bucket: cfg.S3Bucket,
			AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey,
			UploadURL: cmp.Or(cfg.S3UploadURL, strings.TrimSuffix(cfg.PublicURL.String(), "/")+"/"+cfg.S3Bucket+"/"),
		})
		return s, nil, err
	case "azure":
		a, err := storage.NewAzure(storage.AzureConfig{
			Account: cfg.AzureAccount, Key: cfg.AzureKey, Container: cfg.AzureContainer, Endpoint: cfg.AzureEndpoint,
		}, uploads, tickets)
		if err != nil {
			return nil, nil, err
		}
		return a, a, nil
	case "dir":
		d, err := storage.NewDir(cfg.FilesDir, uploads, tickets)
		if err != nil {
			return nil, nil, err
		}
		return d, d, nil
	}
	return nil, nil, nil
}

// importExport reads another chat's export into Cenacle.
func importExport(ctx context.Context, cfg config.Config, log *slog.Logger, args []string) error {
	var opts importer.Options
	if len(args) > 0 && args[0] == "--merge" {
		opts.Merge, args = true, args[1:]
	}
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
	case "cenacle":
		fsys, closeExport, err := importer.Open(args[1])
		if err != nil {
			return err
		}
		defer func() { _ = closeExport() }()
		if data, err = importer.ReadCenacle(fsys); err != nil {
			return fmt.Errorf("reading the export: %w", err)
		}
	case "rocketchat", "zulip", "discord", "teams":
		workspace := ""
		if len(args) > 2 {
			workspace = args[2]
		}
		if args[0] == "rocketchat" && workspace == "" {
			return errors.New("import rocketchat needs the export and a workspace name\n\n" + usage)
		}
		fsys, closeExport, err := importer.Open(args[1])
		if err != nil {
			return err
		}
		defer func() { _ = closeExport() }()
		read := map[string]func(fs.FS, string) (importer.Data, error){
			"rocketchat": importer.ReadRocketChat, "zulip": importer.ReadZulip,
			"discord": importer.ReadDiscord, "teams": importer.ReadTeams,
		}[args[0]]
		if data, err = read(fsys, workspace); err != nil {
			return fmt.Errorf("reading the export: %w", err)
		}
	default:
		return fmt.Errorf("unknown export %q (mattermost, slack, rocketchat, zulip, discord, teams or cenacle)\n\n%s", args[0], usage)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()
	files, closeFiles, err := commandFiles(cfg)
	if err != nil {
		return err
	}
	defer closeFiles()
	log.Info("import starting", "people", len(data.Users), "channels", len(data.Channels), "messages", len(data.Messages))
	res, err := importer.Import(ctx, pool, data, log, files, opts)
	if err != nil {
		return err
	}
	log.Info("import finished", "result", res.String())
	return nil
}

// commandFiles opens the file store for a command (nil when files are off).
func commandFiles(cfg config.Config) (*chat.Files, func(), error) {
	valkey := cache.New(cfg.ValkeyAddr, cfg.ValkeyPassword)
	objects, _, err := openFiles(cfg, valkey)
	if err != nil || objects == nil {
		valkey.Close()
		return nil, func() {}, err
	}
	var scanner *clamav.Scanner
	if cfg.ClamAVAddr != "" {
		scanner = &clamav.Scanner{Addr: cfg.ClamAVAddr}
	}
	return chat.NewFiles(objects, scanner, cfg.FilesMaxSize), valkey.Close, nil
}

// exportWorkspaces writes a Cenacle export.
func exportWorkspaces(ctx context.Context, cfg config.Config, log *slog.Logger, args []string) error {
	if len(args) < 1 {
		return errors.New(usage)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()
	files, closeFiles, err := commandFiles(cfg)
	if err != nil {
		return err
	}
	defer closeFiles()
	if files == nil {
		log.Warn("files are off: the export holds messages without their files")
	}
	out, err := os.OpenFile(args[0], os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // the operator names the file
	if err != nil {
		return err
	}
	res, err := importer.Export(ctx, store.New(pool), out, args[1:], version, files, log)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(args[0]) //nolint:gosec // the file this command just created
		return err
	}
	log.Info("export finished", "file", args[0], "result", res.String())
	return nil
}

// openEscrow prints a person's history backups opened with the escrow key.
func openEscrow(ctx context.Context, cfg config.Config, log *slog.Logger, args []string) error {
	if len(args) < 2 {
		return errors.New(usage)
	}
	pemKey, err := os.ReadFile(args[0]) //nolint:gosec // the operator names the key file
	if err != nil {
		return err
	}
	priv, err := e2e.ParsePrivateKey(pemKey)
	if err != nil {
		return err
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()
	q := store.New(pool)
	person, err := q.FindUserForEscrow(ctx, args[1])
	if err != nil {
		return fmt.Errorf("no person with the address %s", args[1])
	}
	rec, err := q.GetRecovery(ctx, person.ID)
	if err != nil || len(rec.Escrow) == 0 {
		return errors.New("this person has no recovery key sealed for the escrow key")
	}
	key, err := e2e.OpenEscrow(priv, rec.Escrow)
	if err != nil {
		return err
	}
	var channel pgtype.UUID
	if len(args) > 2 {
		if err := channel.Scan(args[2]); err != nil {
			return fmt.Errorf("channel id: %w", err)
		}
	}
	(&audit.Log{Queries: q, Logger: log}).Record(ctx, audit.Event{Action: audit.E2EEscrowOpened,
		TargetType: "user", TargetID: guuid.UUID(person.ID.Bytes).String(),
		Detail: map[string]any{"email": person.Email, "channel": args[2:], "key_id": rec.EscrowKeyID.String}})
	rows, err := q.ListBackupsForEscrow(ctx, store.ListBackupsForEscrowParams{UserID: person.ID, ChannelID: channel})
	if err != nil {
		return err
	}
	out := json.NewEncoder(os.Stdout)
	opened := 0
	for _, b := range rows {
		data, err := e2e.OpenBackup(key, b.Data)
		if err != nil {
			log.Warn("backup not opened", "backup", guuid.UUID(b.ID.Bytes).String(), "error", err)
			continue
		}
		var backup struct {
			Items []struct {
				P json.RawMessage `json:"p"`
			} `json:"items"`
		}
		if json.Unmarshal(data, &backup) != nil {
			continue
		}
		for _, it := range backup.Items {
			if err := out.Encode(map[string]any{
				"channel_id": guuid.UUID(b.ChannelID.Bytes).String(), "backed_up_at": b.CreatedAt, "message": it.P,
			}); err != nil {
				return err
			}
			opened++
		}
	}
	log.Info("escrow opened", "person", person.Email, "texts", opened)
	return nil
}

// operate runs the status and support-bundle commands.
func operate(ctx context.Context, cfg config.Config, args []string) error {
	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()
	valkey := cache.New(cfg.ValkeyAddr, cfg.ValkeyPassword)
	defer valkey.Close()
	checks := []health.Checker{db.Checker{Pool: pool}, valkey}
	objects, _, err := openFiles(cfg, valkey)
	if err != nil {
		return err
	}
	if objects != nil {
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
	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
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
