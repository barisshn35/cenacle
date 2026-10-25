// SPDX-License-Identifier: AGPL-3.0-only

package jobs_test

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/jobs"
	"github.com/barisshn35/cenacle/server/internal/testdb"
)

type counter struct{ n atomic.Int64 }

func (c *counter) PurgeDeleted(context.Context) (int64, error)  { c.n.Add(1); return 0, nil }
func (c *counter) PurgeBurned(context.Context) (int64, error)   { return 0, nil }
func (c *counter) DeleteExpired(context.Context) (int64, error) { c.n.Add(1); return 0, nil }

func TestPeriodicJobsRunOnStart(t *testing.T) {
	pool := testdb.Open(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	if err := jobs.Migrate(ctx, pool, log); err != nil {
		t.Fatal(err)
	}
	if err := jobs.Migrate(ctx, pool, log); err != nil { // again: nothing to do
		t.Fatal(err)
	}
	purged, cleaned := &counter{}, &counter{}
	client, err := jobs.NewClient(pool, jobs.Deps{Purger: purged, Sessions: cleaned, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.Stop(context.Background()) }()
	deadline := time.Now().Add(15 * time.Second)
	for purged.n.Load() == 0 || cleaned.n.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("jobs did not run: purge %d, sessions %d", purged.n.Load(), cleaned.n.Load())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A periodic job is not inserted again while one of its kind waits or runs:
// a slow run is never joined by a second one doing the same work.
func TestPeriodicJobsDoNotOverlap(t *testing.T) {
	pool := testdb.Open(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	if err := jobs.Migrate(ctx, pool, log); err != nil {
		t.Fatal(err)
	}
	client, err := jobs.NewClient(pool, jobs.Deps{Purger: &counter{}, Sessions: &counter{}, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	first, err := client.Insert(ctx, jobs.PurgeMessagesArgs{}, jobs.PeriodicOpts())
	if err != nil || first.UniqueSkippedAsDuplicate {
		t.Fatalf("first insert: %+v %v", first, err)
	}
	second, err := client.Insert(ctx, jobs.PurgeMessagesArgs{}, jobs.PeriodicOpts())
	if err != nil || !second.UniqueSkippedAsDuplicate {
		t.Fatalf("second insert was not skipped: %+v %v", second, err)
	}
	if first.Job.MaxAttempts != 1 {
		t.Errorf("max attempts = %d", first.Job.MaxAttempts)
	}
}
