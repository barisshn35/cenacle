// SPDX-License-Identifier: Apache-2.0

package events_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strconv"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/store"
	"github.com/barisshn35/cenacle/server/internal/testdb"
)

func TestRelayMovesOutboxEventsInOrderWithOneLeader(t *testing.T) {
	pool := testdb.Open(t)
	l := newLog(t)
	q := store.New(pool)
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))

	ctx1, stop1 := context.WithCancel(context.Background())
	defer stop1()
	ctx2, stop2 := context.WithCancel(context.Background())
	defer stop2()
	relay := func(ctx context.Context) {
		go (&events.Relay{Pool: pool, Log: l, Logger: quiet, Idle: 50 * time.Millisecond}).Run(ctx)
	}

	insert := func(from, to int) {
		for i := from; i < to; i++ {
			raw, _ := json.Marshal(map[string]int{"n": i})
			if err := q.InsertOutboxEvent(context.Background(), store.InsertOutboxEventParams{Type: "test", Data: raw}); err != nil {
				t.Fatal(err)
			}
		}
	}
	waitFor := func(n int) []events.Event {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			got, err := l.Since(context.Background(), events.ID{}, 1000)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) >= n {
				return got
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("events did not arrive")
		return nil
	}

	relay(ctx1)    // the first instance leads
	insert(0, 150) // more than one batch
	waitFor(150)
	relay(ctx2) // a second one stands by
	time.Sleep(100 * time.Millisecond)
	stop1() // and takes over when the leader stops
	insert(150, 160)
	got := waitFor(160)
	if len(got) != 160 {
		t.Fatalf("relayed %d events, want 160 (no duplicates while healthy)", len(got))
	}
	for i, ev := range got {
		var d struct{ N int }
		_ = json.Unmarshal(ev.Data, &d)
		if ev.Type != "test" || d.N != i {
			t.Fatalf("event %d = %s %s, want n=%s", i, ev.Type, ev.Data, strconv.Itoa(i))
		}
	}
	rows, err := q.ListOutboxEvents(context.Background(), 10)
	if err != nil || len(rows) != 0 {
		t.Errorf("outbox not emptied: %d rows, %v", len(rows), err)
	}
}
