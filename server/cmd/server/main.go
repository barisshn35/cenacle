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
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"github.com/barisshn35/cenacle/server/internal/app"
	"github.com/barisshn35/cenacle/server/internal/cache"
	"github.com/barisshn35/cenacle/server/internal/config"
	"github.com/barisshn35/cenacle/server/internal/db"
	"github.com/barisshn35/cenacle/server/internal/health"
	"github.com/barisshn35/cenacle/server/internal/logging"
	"github.com/barisshn35/cenacle/server/internal/store"
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
	case "serve", "migrate":
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}

	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	log := logging.New(os.Stdout, cfg.LogFormat, cfg.LogLevel).With("build", version)
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if args[0] == "migrate" {
		if len(args) != 2 {
			return errors.New(usage)
		}
		return migrate(ctx, cfg, log, args[1])
	}
	return serve(ctx, cfg, log)
}

func serve(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	valkey := cache.New(cfg.ValkeyAddr, cfg.ValkeyPassword)
	defer valkey.Close()

	// Log the database clock once at startup as a smoke test of the sqlc
	// layer; failure is not fatal because /readyz reports it.
	if now, err := store.New(pool).ServerTime(ctx); err == nil {
		log.Info("database reachable", "db_time", now.UTC())
	} else {
		log.Warn("database not reachable at startup", "error", err)
	}

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: app.NewRouter(app.Deps{
			Log:          log,
			Checkers:     []health.Checker{db.Checker{Pool: pool}, valkey},
			ReadyTimeout: cfg.ReadyTimeout,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("http server listening", "addr", cfg.HTTPAddr, "env", cfg.Env)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	case <-ctx.Done():
	}

	log.Info("shutting down", "timeout", cfg.ShutdownTimeout)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	log.Info("shutdown complete")
	return nil
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
		return nil
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
