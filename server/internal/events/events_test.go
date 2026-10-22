// SPDX-License-Identifier: AGPL-3.0-only

package events_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/events"
	"github.com/barisshn35/cenacle/server/internal/testdb"
)

func newLog(t *testing.T) *events.Log {
	t.Helper()
	vk := testdb.Valkey(t)
	l := &events.Log{Valkey: vk, Key: "test:events:" + testdb.Suffix(), MaxLen: 1000}
	t.Cleanup(func() {
		vc, _ := vk.Get()
		vc.Do(context.Background(), vc.B().Del().Key(l.Key).Build())
	})
	return l
}

func TestParseID(t *testing.T) {
	a, err := events.ParseID("1700000000000-2")
	if err != nil || a.String() != "1700000000000-2" {
		t.Fatalf("ParseID = %v, %v", a, err)
	}
	b, _ := events.ParseID("1700000000000-10")
	if !a.Less(b) || b.Less(a) {
		t.Error("ordering by sequence")
	}
	for _, bad := range []string{"", "1", "a-1", "1-b", "-"} {
		if _, err := events.ParseID(bad); err == nil {
			t.Errorf("ParseID(%q) accepted", bad)
		}
	}
}

func TestAppendSinceAndState(t *testing.T) {
	ctx := context.Background()
	l := newLog(t)

	st, err := l.State(ctx)
	if err != nil || st.Last != (events.ID{}) {
		t.Fatalf("empty state = %+v, %v", st, err)
	}
	var ids []events.ID
	for i := range 3 {
		ev, err := l.Append(ctx, events.MessageCreated, map[string]int{"n": i})
		if err != nil {
			t.Fatal(err)
		}
		id, _ := events.ParseID(ev.ID)
		ids = append(ids, id)
	}
	got, err := l.Since(ctx, ids[0], 10)
	if err != nil || len(got) != 2 || got[0].ID != ids[1].String() || string(got[1].Data) != `{"n":2}` ||
		got[1].Type != events.MessageCreated {
		t.Fatalf("Since = %+v, %v", got, err)
	}
	if got, err := l.Since(ctx, ids[2], 10); err != nil || len(got) != 0 {
		t.Errorf("Since(last) = %v, %v", got, err)
	}
	if _, err := l.Since(ctx, events.ID{}, 2); !errors.Is(err, events.ErrGap) {
		t.Errorf("more than limit: %v", err)
	}
	// An id newer than the stream: Valkey lost its data.
	if _, err := l.Since(ctx, events.ID{Ms: ids[2].Ms + 60_000}, 10); !errors.Is(err, events.ErrGap) {
		t.Errorf("future id: %v", err)
	}

	// Trimmed events cannot be resumed from.
	vc, _ := l.Valkey.Get()
	if err := vc.Do(ctx, vc.B().Xtrim().Key(l.Key).Maxlen().Threshold("1").Build()).Error(); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Since(ctx, ids[0], 10); !errors.Is(err, events.ErrGap) {
		t.Errorf("after trimming: %v", err)
	}
	if got, err := l.Since(ctx, ids[2], 10); err != nil || len(got) != 0 {
		t.Errorf("from the first kept id: %v, %v", got, err)
	}
}

func TestFollow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	l := newLog(t)
	first, _ := l.Append(ctx, "a", 1)
	start, _ := events.ParseID(first.ID)

	got := make(chan events.Event, 4)
	fctx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		_, err := l.Follow(fctx, start, func(ev events.Event) { got <- ev })
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	second, _ := l.Append(ctx, "b", 2)
	select {
	case ev := <-got:
		if ev.ID != second.ID || ev.Type != "b" {
			t.Errorf("followed %+v, want %s", ev, second.ID)
		}
	case <-ctx.Done():
		t.Fatal("no event followed")
	}
	stop()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Errorf("Follow ended with %v", err)
	}
}
