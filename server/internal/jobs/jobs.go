// SPDX-License-Identifier: Apache-2.0

// Package jobs runs background work with River (a PostgreSQL job queue): each
// periodic job runs once per interval across all instances, and later
// versions add jobs written in the same transaction as the change that needs
// them (webhooks, notifications).
package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

// Purger removes deleted messages that can no longer be restored.
type Purger interface {
	PurgeDeleted(ctx context.Context) (int64, error)
}

// SessionCleaner removes sessions that can no longer be used.
type SessionCleaner interface {
	DeleteExpired(ctx context.Context) (int64, error)
}

// PurgeMessagesArgs is the periodic purge of deleted messages.
type PurgeMessagesArgs struct{}

// Kind implements river.JobArgs.
func (PurgeMessagesArgs) Kind() string { return "purge_deleted_messages" }

// CleanSessionsArgs is the periodic removal of expired sessions.
type CleanSessionsArgs struct{}

// Kind implements river.JobArgs.
func (CleanSessionsArgs) Kind() string { return "clean_expired_sessions" }

type purgeWorker struct {
	river.WorkerDefaults[PurgeMessagesArgs]
	purger Purger
	log    *slog.Logger
}

func (w *purgeWorker) Work(ctx context.Context, _ *river.Job[PurgeMessagesArgs]) error {
	n, err := w.purger.PurgeDeleted(ctx)
	if n > 0 {
		w.log.Info("deleted messages purged", "count", n)
	}
	return err
}

type sessionsWorker struct {
	river.WorkerDefaults[CleanSessionsArgs]
	cleaner SessionCleaner
	log     *slog.Logger
}

func (w *sessionsWorker) Work(ctx context.Context, _ *river.Job[CleanSessionsArgs]) error {
	n, err := w.cleaner.DeleteExpired(ctx)
	if n > 0 {
		w.log.Info("expired sessions deleted", "count", n)
	}
	return err
}

// Deps are what the jobs work on.
type Deps struct {
	Purger   Purger
	Sessions SessionCleaner
	Log      *slog.Logger
}

// NewClient returns a River client with the periodic jobs; Start it to work.
func NewClient(pool *pgxpool.Pool, d Deps) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &purgeWorker{purger: d.Purger, log: d.Log})
	river.AddWorker(workers, &sessionsWorker{cleaner: d.Sessions, log: d.Log})
	periodic := func(every time.Duration, args river.JobArgs) *river.PeriodicJob {
		return river.NewPeriodicJob(river.PeriodicInterval(every),
			func() (river.JobArgs, *river.InsertOpts) { return args, nil },
			&river.PeriodicJobOpts{RunOnStart: true})
	}
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Queues: map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 10}},
		PeriodicJobs: []*river.PeriodicJob{
			periodic(time.Minute, PurgeMessagesArgs{}),
			periodic(10*time.Minute, CleanSessionsArgs{}),
		},
		Workers: workers,
		Logger:  d.Log,
	})
	if err != nil {
		return nil, fmt.Errorf("river client: %w", err)
	}
	return client, nil
}

// Migrate brings River's tables up to date (they live next to the chat
// server's own tables and run under River's lock).
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	migrator, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Logger: log})
	if err != nil {
		return err
	}
	res, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
	if err != nil {
		return fmt.Errorf("river migrations: %w", err)
	}
	for _, v := range res.Versions {
		log.Info("river migration applied", "version", v.Version, "name", v.Name)
	}
	return nil
}
