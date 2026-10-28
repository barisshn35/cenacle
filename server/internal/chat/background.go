// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/egress"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
	"github.com/barisshn35/cenacle/server/internal/store"
	"github.com/barisshn35/cenacle/server/internal/telemetry"
)

// Delivery headers sent with every event.
const (
	DeliveryHeader = "X-Cenacle-Delivery"
	EventHeader    = "X-Cenacle-Event"
)

// MaxDeliveryAttempts is how often an event is tried before it counts as failed.
const MaxDeliveryAttempts = 8

const (
	deliveryBatch  = 50
	scheduledBatch = 100
	senders        = 8
)

// Background does the integration work that runs outside requests: event
// deliveries and scheduled messages (driven by periodic jobs).
type Background struct {
	DB      TxBeginner
	Queries *store.Queries
	Egress  *egress.Client
	Files   *Files
	Log     *slog.Logger
}

// PruneFiles implements jobs.Integrations.
func (b *Background) PruneFiles(ctx context.Context) (int, error) {
	return b.Files.PruneFiles(ctx, b.Queries)
}

// retryIn is the wait before the next attempt after `attempts` failed ones.
func retryIn(attempts int32) time.Duration {
	return min(30*time.Second<<max(attempts-1, 0), time.Hour)
}

// delivery is the body a subscriber receives.
type delivery struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	CreatedAt time.Time       `json:"created_at"`
	Data      json.RawMessage `json:"data"`
}

// DeliverDue sends the deliveries that are due; it returns how many it tried.
func (b *Background) DeliverDue(ctx context.Context) (int, error) {
	if b.Egress == nil {
		return 0, nil
	}
	rows, err := b.Queries.ClaimDueDeliveries(ctx, deliveryBatch)
	if err != nil {
		return 0, err
	}
	var wg sync.WaitGroup
	work := make(chan store.ClaimDueDeliveriesRow)
	errs := make(chan error, len(rows))
	for range min(senders, len(rows)) {
		wg.Go(func() {
			for d := range work {
				if err := b.deliver(ctx, d); err != nil {
					errs <- err
				}
			}
		})
	}
	for _, d := range rows {
		work <- d
	}
	close(work)
	wg.Wait()
	close(errs)
	return len(rows), errors.Join(collect(errs)...)
}

func collect(errs <-chan error) []error {
	var out []error
	for err := range errs {
		out = append(out, err)
	}
	return out
}

func (b *Background) deliver(ctx context.Context, d store.ClaimDueDeliveriesRow) error {
	body, err := json.Marshal(delivery{ID: uuid(d.ID).String(), Type: d.EventType, CreatedAt: d.CreatedAt, Data: d.Payload})
	if err != nil {
		return err
	}
	finish := store.FinishDeliveryParams{ID: d.ID, Status: "succeeded", NextAttemptAt: time.Now()}
	status, problem := b.post(ctx, d, body)
	if status != 0 {
		finish.LastStatus = pgtype.Int4{Int32: int32(status), Valid: true} //nolint:gosec // an HTTP status
	}
	if problem != "" {
		finish.LastError = truncate(problem, 500)
		finish.Status = "pending"
		finish.NextAttemptAt = time.Now().Add(retryIn(d.Attempts))
		if d.Attempts >= MaxDeliveryAttempts {
			finish.Status = "failed"
		}
	}
	result := "succeeded"
	if problem != "" {
		result = "retry"
		if finish.Status == "failed" {
			result = "failed"
		}
	}
	telemetry.Deliveries.WithLabelValues(result).Inc()
	// Finish even when the job's context ended, so the lease does not linger.
	return b.Queries.FinishDelivery(context.WithoutCancel(ctx), finish)
}

func (b *Background) post(ctx context.Context, d store.ClaimDueDeliveriesRow, body []byte) (int, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.Url, bytes.NewReader(body))
	if err != nil {
		return 0, err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Cenacle")
	req.Header.Set(DeliveryHeader, uuid(d.ID).String())
	req.Header.Set(EventHeader, d.EventType)
	req.Header.Set(signing.Header, signing.Sign(d.Secret, time.Now(), body))
	res, err := b.Egress.Do(req)
	switch {
	case errors.Is(err, egress.ErrForbiddenAddress):
		return 0, "The address is in a network Cenacle may not reach (see CENACLE_EGRESS_ALLOW)."
	case err != nil:
		return 0, err.Error()
	case res.Status < 200 || res.Status > 299:
		return res.Status, fmt.Sprintf("The receiver answered %d.", res.Status)
	}
	return res.Status, ""
}

func truncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// PruneDeliveries implements jobs: old delivery records go away.
func (b *Background) PruneDeliveries(ctx context.Context) (int64, error) {
	return b.Queries.PruneDeliveries(ctx)
}

// SendDueScheduled posts the scheduled messages that are due. A batch is one
// transaction: a crash leaves the batch pending, never marked sent unsent.
func (b *Background) SendDueScheduled(ctx context.Context) (int, error) {
	n := 0
	err := inTx(ctx, b.DB, func(q *store.Queries) error {
		rows, err := q.ClaimDueScheduled(ctx, scheduledBatch)
		if err != nil {
			return err
		}
		n = len(rows)
		for _, s := range rows {
			msgID, problem, err := sendScheduled(ctx, q, s)
			if err != nil {
				return err
			}
			finish := store.FinishScheduledParams{ID: s.ID, Status: "sent", MessageID: msgID}
			if problem != "" {
				finish.Status, finish.Error = "failed", problem
			}
			if err := q.FinishScheduled(ctx, finish); err != nil {
				return err
			}
		}
		return nil
	})
	return n, err
}

// sendScheduled posts one scheduled message if its author may still post there.
func sendScheduled(ctx context.Context, q *store.Queries, s store.ScheduledMessage) (pgtype.UUID, string, error) {
	c, err := q.GetChannel(ctx, s.ChannelID)
	if isNoRows(err) {
		return pgtype.UUID{}, "The channel no longer exists.", nil
	}
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	author, err := q.GetUser(ctx, s.AuthorID)
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	// A deactivated person posts nothing more, nor do reminders sent for them.
	owner := author
	if s.OwnerID != s.AuthorID {
		if owner, err = q.GetUser(ctx, s.OwnerID); err != nil {
			return pgtype.UUID{}, "", err
		}
	}
	if author.DeactivatedAt.Valid || owner.DeactivatedAt.Valid {
		return pgtype.UUID{}, "The account is deactivated.", nil
	}
	ws, err := q.GetWorkspaceRole(ctx, store.GetWorkspaceRoleParams{WorkspaceID: c.WorkspaceID, UserID: author.ID})
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	ch, err := q.GetMemberRole(ctx, store.GetMemberRoleParams{ChannelID: c.ID, UserID: author.ID})
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	role := access{ch: ch, ws: ws}
	switch {
	case ws == "" || ch == "":
		return pgtype.UUID{}, "You are no longer a member of the channel.", nil
	case !canPost(c, role):
		return pgtype.UUID{}, "You can no longer send messages in the channel.", nil
	}
	m, err := postMessage(ctx, q, c, author, s.Body, "scheduled-"+uuid(s.ID).String(), []byte("[]"))
	if errors.Is(err, errNonceReused) {
		return pgtype.UUID{}, "The message could not be sent.", nil
	}
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	return pgUUID(m.Id), "", nil
}
