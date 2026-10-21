// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/barisshn35/cenacle/server/internal/store"
)

// outboxLock names the relay's advisory lock; the schema is part of it, so
// installations (and test schemas) sharing a database each have their own relay.
const outboxLock = `hashtext(current_schema() || '.cenacle_outbox')`

// outboxBatch is how many events the relay moves at a time.
const outboxBatch = 100

// Relay moves events from the transactional outbox (written together with the
// change they describe) to the live event log, in order. One relay is active
// per installation, chosen by a PostgreSQL advisory lock; the others wait to
// take over. Delivery is at least once: an event appended right before a crash
// may be appended again (clients ignore what they already have).
type Relay struct {
	Pool   *pgxpool.Pool
	Log    *Log
	Logger *slog.Logger
	// Idle is how long the relay waits for a notification before looking
	// anyway (default 1 s).
	Idle time.Duration
}

// Run relays until ctx ends.
func (r *Relay) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		led, err := r.lead(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			r.Logger.Warn("event relay", "error", err)
			select {
			case <-ctx.Done():
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		if !led { // another instance relays; check again later
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func (r *Relay) idle() time.Duration {
	if r.Idle > 0 {
		return r.Idle
	}
	return time.Second
}

// lead relays while holding the lock; it reports whether it got the lock.
func (r *Relay) lead(ctx context.Context) (bool, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock("+outboxLock+")").Scan(&got); err != nil {
		return false, err
	}
	if !got {
		return false, nil
	}
	// The lock belongs to this connection: give it back before the pool reuses it.
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock("+outboxLock+")")
	}()
	if _, err := conn.Exec(ctx, "LISTEN cenacle_outbox"); err != nil {
		return true, err
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "UNLISTEN cenacle_outbox") }()

	q := store.New(conn)
	for {
		n, err := r.drain(ctx, q)
		if err != nil {
			return true, err
		}
		if n == outboxBatch {
			continue // more are waiting
		}
		wctx, cancel := context.WithTimeout(ctx, r.idle())
		_, err = conn.Conn().WaitForNotification(wctx)
		cancel()
		if ctx.Err() != nil {
			return true, nil
		}
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return true, err
		}
	}
}

// drain appends one batch to the log and removes what was appended.
func (r *Relay) drain(ctx context.Context, q *store.Queries) (int, error) {
	rows, err := q.ListOutboxEvents(ctx, outboxBatch)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	var last int64
	var appendErr error
	for _, row := range rows {
		if _, appendErr = r.Log.Append(ctx, row.Type, json.RawMessage(row.Data)); appendErr != nil {
			break
		}
		last = row.ID
	}
	if last > 0 {
		if err := q.DeleteOutboxEvents(ctx, last); err != nil {
			return 0, err
		}
	}
	return len(rows), appendErr
}
