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

// Integrations is the integration work done in the background.
type Integrations interface {
	DeliverDue(ctx context.Context) (int, error)
	SendDueScheduled(ctx context.Context) (int, error)
	PruneDeliveries(ctx context.Context) (int64, error)
	// PruneFiles removes unsent uploads and files of purged messages.
	PruneFiles(ctx context.Context) (int, error)
}

// PruneFilesArgs removes files nobody can reach any more.
type PruneFilesArgs struct{}

// Kind implements river.JobArgs.
func (PruneFilesArgs) Kind() string { return "prune_files" }

type pruneFilesWorker struct {
	river.WorkerDefaults[PruneFilesArgs]
	in  Integrations
	log *slog.Logger
}

func (w *pruneFilesWorker) Work(ctx context.Context, _ *river.Job[PruneFilesArgs]) error {
	total := 0
	for {
		n, err := w.in.PruneFiles(ctx)
		total += n
		if err != nil || n == 0 || ctx.Err() != nil {
			if total > 0 {
				w.log.Info("stale files removed", "count", total)
			}
			return err
		}
	}
}

// DeliverEventsArgs sends due event deliveries to bots.
type DeliverEventsArgs struct{}

// Kind implements river.JobArgs.
func (DeliverEventsArgs) Kind() string { return "deliver_events" }

// SendScheduledArgs posts due scheduled messages and reminders.
type SendScheduledArgs struct{}

// Kind implements river.JobArgs.
func (SendScheduledArgs) Kind() string { return "send_scheduled_messages" }

// PruneDeliveriesArgs removes old delivery records.
type PruneDeliveriesArgs struct{}

// Kind implements river.JobArgs.
func (PruneDeliveriesArgs) Kind() string { return "prune_deliveries" }

type deliverWorker struct {
	river.WorkerDefaults[DeliverEventsArgs]
	in Integrations
}

func (w *deliverWorker) Work(ctx context.Context, _ *river.Job[DeliverEventsArgs]) error {
	// Keep going while some were due (failed ones wait for their retry time).
	for {
		n, err := w.in.DeliverDue(ctx)
		if err != nil || n == 0 || ctx.Err() != nil {
			return err
		}
	}
}

type scheduledWorker struct {
	river.WorkerDefaults[SendScheduledArgs]
	in Integrations
}

func (w *scheduledWorker) Work(ctx context.Context, _ *river.Job[SendScheduledArgs]) error {
	for {
		n, err := w.in.SendDueScheduled(ctx)
		if err != nil || n == 0 || ctx.Err() != nil {
			return err
		}
	}
}

type pruneDeliveriesWorker struct {
	river.WorkerDefaults[PruneDeliveriesArgs]
	in  Integrations
	log *slog.Logger
}

func (w *pruneDeliveriesWorker) Work(ctx context.Context, _ *river.Job[PruneDeliveriesArgs]) error {
	n, err := w.in.PruneDeliveries(ctx)
	if n > 0 {
		w.log.Info("old deliveries pruned", "count", n)
	}
	return err
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

// How often due deliveries and scheduled messages are looked for.
var (
	DeliveryInterval  = 5 * time.Second
	ScheduledInterval = 10 * time.Second
)

// Deps are what the jobs work on.
type Deps struct {
	Purger   Purger
	Sessions SessionCleaner
	// Integrations is optional (tests of other parts leave it out).
	Integrations Integrations
	Log          *slog.Logger
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
	jobs := []*river.PeriodicJob{
		periodic(time.Minute, PurgeMessagesArgs{}),
		periodic(10*time.Minute, CleanSessionsArgs{}),
	}
	if d.Integrations != nil {
		river.AddWorker(workers, &deliverWorker{in: d.Integrations})
		river.AddWorker(workers, &scheduledWorker{in: d.Integrations})
		river.AddWorker(workers, &pruneDeliveriesWorker{in: d.Integrations, log: d.Log})
		river.AddWorker(workers, &pruneFilesWorker{in: d.Integrations, log: d.Log})
		jobs = append(jobs,
			periodic(DeliveryInterval, DeliverEventsArgs{}),
			periodic(ScheduledInterval, SendScheduledArgs{}),
			periodic(24*time.Hour, PruneDeliveriesArgs{}),
			periodic(time.Hour, PruneFilesArgs{}))
	}
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Queues:       map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 10}},
		PeriodicJobs: jobs,
		Workers:      workers,
		Logger:       d.Log,
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
