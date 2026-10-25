// SPDX-License-Identifier: AGPL-3.0-only

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
	"github.com/riverqueue/river/rivertype"
)

// Purger removes deleted messages that can no longer be restored.
type Purger interface {
	PurgeDeleted(ctx context.Context) (int64, error)
	// PurgeBurned removes burn-on-read messages that have been read.
	PurgeBurned(ctx context.Context) (int64, error)
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

// Profiles keeps profiles tidy: expired custom statuses, missing @usernames.
type Profiles interface {
	TidyProfiles(ctx context.Context) (int, error)
}

// TidyProfilesArgs is the periodic tidying of profiles.
type TidyProfilesArgs struct{}

// Kind implements river.JobArgs.
func (TidyProfilesArgs) Kind() string { return "tidy_profiles" }

type profilesWorker struct {
	river.WorkerDefaults[TidyProfilesArgs]
	p Profiles
}

func (w *profilesWorker) Work(ctx context.Context, _ *river.Job[TidyProfilesArgs]) error {
	_, err := w.p.TidyProfiles(ctx)
	return err
}

// ProfilesInterval is how often expired custom statuses are cleared.
var ProfilesInterval = 30 * time.Second

// Runner is a periodic piece of work that reports how much it did.
type Runner interface {
	Run(ctx context.Context) (int, error)
}

// PushNotificationsArgs sends web push about new messages.
type PushNotificationsArgs struct{}

// Kind implements river.JobArgs.
func (PushNotificationsArgs) Kind() string { return "push_notifications" }

// ReadFeedsArgs reads the feeds channels follow.
type ReadFeedsArgs struct{}

// Kind implements river.JobArgs.
func (ReadFeedsArgs) Kind() string { return "read_feeds" }

// FeedsInterval is how often due feeds are looked for.
var FeedsInterval = time.Minute

// SendRemindersArgs reminds people of urgent messages they have not acknowledged.
type SendRemindersArgs struct{}

// Kind implements river.JobArgs.
func (SendRemindersArgs) Kind() string { return "send_reminders" }

// ReminderInterval is how often due reminders are looked for.
var ReminderInterval = 30 * time.Second

// FetchLinkPreviewsArgs fetches the previews of new messages' links.
type FetchLinkPreviewsArgs struct{}

// Kind implements river.JobArgs.
func (FetchLinkPreviewsArgs) Kind() string { return "fetch_link_previews" }

// RunWorkflowsArgs runs workflows' due steps and starts scheduled workflows.
type RunWorkflowsArgs struct{}

// Kind implements river.JobArgs.
func (RunWorkflowsArgs) Kind() string { return "run_workflows" }

// WorkflowsInterval is how often workflows' due steps run.
var WorkflowsInterval = 2 * time.Second

// LinksInterval is how often new links are looked for.
var LinksInterval = 3 * time.Second

// PurgeExpiredArgs deletes messages older than their retention.
type PurgeExpiredArgs struct{}

// Kind implements river.JobArgs.
func (PurgeExpiredArgs) Kind() string { return "purge_expired_messages" }

// RetentionInterval is how often expired messages are deleted (in batches).
var RetentionInterval = time.Minute

// SendFederationArgs sends shared channels' events to other servers.
type SendFederationArgs struct{}

// Kind implements river.JobArgs.
func (SendFederationArgs) Kind() string { return "send_federation" }

// FederationInterval is how often events go to other servers.
var FederationInterval = 2 * time.Second

// StreamAuditArgs sends new audit events to the SIEM.
type StreamAuditArgs struct{}

// Kind implements river.JobArgs.
func (StreamAuditArgs) Kind() string { return "stream_audit" }

// AuditStreamInterval is how often new audit events go to the SIEM.
var AuditStreamInterval = 5 * time.Second

// ReadFileTextArgs reads the text of new files for search.
type ReadFileTextArgs struct{}

// Kind implements river.JobArgs.
func (ReadFileTextArgs) Kind() string { return "read_file_text" }

// FileTextInterval is how often new files are read.
var FileTextInterval = 10 * time.Second

// ExportArchiveArgs writes whole days of workspaces with daily archive exports.
type ExportArchiveArgs struct{}

// Kind implements river.JobArgs.
func (ExportArchiveArgs) Kind() string { return "export_archive" }

// ArchiveInterval is how often finished days are looked for.
var ArchiveInterval = 10 * time.Minute

// EmailNotificationsArgs e-mails people about what they missed.
type EmailNotificationsArgs struct{}

// Kind implements river.JobArgs.
func (EmailNotificationsArgs) Kind() string { return "email_notifications" }

type runnerWorker[T river.JobArgs] struct {
	river.WorkerDefaults[T]
	r    Runner
	what string
	log  *slog.Logger
	// timeout replaces River's default of a minute (zero keeps it).
	timeout time.Duration
}

// Timeout implements river.Worker.
func (w *runnerWorker[T]) Timeout(*river.Job[T]) time.Duration { return w.timeout }

// Time limits of the jobs that may run longer than River's default minute.
// Push and e-mail note their progress as they go, so a run cut short loses
// nothing; the others are bounded by what one run takes on.
const (
	NotifyTimeout    = 5 * time.Minute  // a run of web push or e-mail
	FileTextTimeout  = 15 * time.Minute // a batch of files (each read is bounded)
	ArchiveTimeout   = time.Hour        // whole days of a workspace
	AuditTimeout     = 10 * time.Minute // a backlog for a SIEM that was away
	DirectoryTimeout = 15 * time.Minute // a full directory sync
)

func (w *runnerWorker[T]) Work(ctx context.Context, _ *river.Job[T]) error {
	n, err := w.r.Run(ctx)
	if n > 0 {
		w.log.Info(w.what, "count", n)
	}
	return err
}

// Directory follows Cenacle ID's directory feed.
type Directory interface {
	Sync(ctx context.Context) (int, error)
}

// SyncDirectoryArgs applies the changes of Cenacle ID's directory.
type SyncDirectoryArgs struct{}

// Kind implements river.JobArgs.
func (SyncDirectoryArgs) Kind() string { return "sync_directory" }

type directoryWorker struct {
	river.WorkerDefaults[SyncDirectoryArgs]
	dir Directory
	log *slog.Logger
}

// Timeout implements river.Worker.
func (w *directoryWorker) Timeout(*river.Job[SyncDirectoryArgs]) time.Duration {
	return DirectoryTimeout
}

func (w *directoryWorker) Work(ctx context.Context, _ *river.Job[SyncDirectoryArgs]) error {
	n, err := w.dir.Sync(ctx)
	if n > 0 {
		w.log.Info("directory changes applied", "people", n)
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
	if err != nil {
		return err
	}
	n, err = w.purger.PurgeBurned(ctx)
	if n > 0 {
		w.log.Info("burned messages purged", "count", n)
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
	// Directory is optional: the chat follows Cenacle ID's directory feed.
	Directory Directory
	// Profiles is optional.
	Profiles Profiles
	// Push and Email are optional (web push, e-mail notifications).
	Push  Runner
	Email Runner
	// Reminders is optional (reminders of urgent messages).
	Reminders Runner
	// Feeds is optional (feeds channels follow).
	Feeds Runner
	// Links is optional (link previews may be turned off).
	Links Runner
	// Workflows is optional.
	Workflows Runner
	// Retention is optional.
	Retention Runner
	// Federation is optional.
	Federation Runner
	// AuditStream is optional.
	AuditStream Runner
	// Archive is optional.
	Archive Runner
	// FileText is optional.
	FileText Runner
	Log      *slog.Logger
}

// PeriodicOpts are the insert options of every periodic job: at most one
// of a kind waits or runs at a time, so a run that outlasts its interval is
// not joined by a second one doing (or sending) the same work. A failed run
// is not retried: the next interval runs it again anyway, and a retry
// waiting for its backoff would otherwise run next to that.
func PeriodicOpts() *river.InsertOpts {
	return &river.InsertOpts{
		MaxAttempts: 1,
		UniqueOpts: river.UniqueOpts{ByState: []rivertype.JobState{
			rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRunning, rivertype.JobStateScheduled,
		}},
	}
}

// NewClient returns a River client with the periodic jobs; Start it to work.
func NewClient(pool *pgxpool.Pool, d Deps) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &purgeWorker{purger: d.Purger, log: d.Log})
	river.AddWorker(workers, &sessionsWorker{cleaner: d.Sessions, log: d.Log})
	periodic := func(every time.Duration, args river.JobArgs) *river.PeriodicJob {
		return river.NewPeriodicJob(river.PeriodicInterval(every),
			func() (river.JobArgs, *river.InsertOpts) { return args, PeriodicOpts() },
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
	if d.Push != nil {
		river.AddWorker(workers, &runnerWorker[PushNotificationsArgs]{r: d.Push, what: "web push sent", log: d.Log, timeout: NotifyTimeout})
		jobs = append(jobs, periodic(10*time.Second, PushNotificationsArgs{}))
	}
	if d.Feeds != nil {
		river.AddWorker(workers, &runnerWorker[ReadFeedsArgs]{r: d.Feeds, what: "feed items posted", log: d.Log})
		jobs = append(jobs, periodic(FeedsInterval, ReadFeedsArgs{}))
	}
	if d.Reminders != nil {
		river.AddWorker(workers, &runnerWorker[SendRemindersArgs]{r: d.Reminders, what: "reminders sent", log: d.Log})
		jobs = append(jobs, periodic(ReminderInterval, SendRemindersArgs{}))
	}
	if d.Email != nil {
		river.AddWorker(workers, &runnerWorker[EmailNotificationsArgs]{r: d.Email, what: "notification e-mails sent", log: d.Log, timeout: NotifyTimeout})
		jobs = append(jobs, periodic(time.Minute, EmailNotificationsArgs{}))
	}
	if d.Workflows != nil {
		river.AddWorker(workers, &runnerWorker[RunWorkflowsArgs]{r: d.Workflows, what: "workflow steps run", log: d.Log})
		jobs = append(jobs, periodic(WorkflowsInterval, RunWorkflowsArgs{}))
	}
	if d.Federation != nil {
		river.AddWorker(workers, &runnerWorker[SendFederationArgs]{r: d.Federation, what: "federated events sent", log: d.Log})
		jobs = append(jobs, periodic(FederationInterval, SendFederationArgs{}))
	}
	if d.FileText != nil {
		river.AddWorker(workers, &runnerWorker[ReadFileTextArgs]{r: d.FileText, what: "file texts read", log: d.Log, timeout: FileTextTimeout})
		jobs = append(jobs, periodic(FileTextInterval, ReadFileTextArgs{}))
	}
	if d.Archive != nil {
		river.AddWorker(workers, &runnerWorker[ExportArchiveArgs]{r: d.Archive, what: "archive days exported", log: d.Log, timeout: ArchiveTimeout})
		jobs = append(jobs, periodic(ArchiveInterval, ExportArchiveArgs{}))
	}
	if d.AuditStream != nil {
		river.AddWorker(workers, &runnerWorker[StreamAuditArgs]{r: d.AuditStream, what: "audit events streamed", log: d.Log, timeout: AuditTimeout})
		jobs = append(jobs, periodic(AuditStreamInterval, StreamAuditArgs{}))
	}
	if d.Retention != nil {
		river.AddWorker(workers, &runnerWorker[PurgeExpiredArgs]{r: d.Retention, what: "expired messages deleted", log: d.Log})
		jobs = append(jobs, periodic(RetentionInterval, PurgeExpiredArgs{}))
	}
	if d.Links != nil {
		river.AddWorker(workers, &runnerWorker[FetchLinkPreviewsArgs]{r: d.Links, what: "link previews settled", log: d.Log})
		jobs = append(jobs, periodic(LinksInterval, FetchLinkPreviewsArgs{}))
	}
	if d.Profiles != nil {
		river.AddWorker(workers, &profilesWorker{p: d.Profiles})
		jobs = append(jobs, periodic(ProfilesInterval, TidyProfilesArgs{}))
	}
	if d.Directory != nil {
		river.AddWorker(workers, &directoryWorker{dir: d.Directory, log: d.Log})
		jobs = append(jobs, periodic(time.Minute, SyncDirectoryArgs{}))
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
