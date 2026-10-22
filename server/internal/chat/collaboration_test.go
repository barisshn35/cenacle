// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/store"
)

// positions records the positions moveTo writes.
type positions struct {
	store.Querier
	set map[pgtype.UUID]float64
}

func (p *positions) SetListItemPosition(_ context.Context, arg store.SetListItemPositionParams) error {
	p.set[arg.ID] = arg.Position
	return nil
}

func rowID(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{n}, Valid: true} }

func TestMoveTo(t *testing.T) {
	items := func(pos ...float64) []store.ListItem {
		out := make([]store.ListItem, len(pos))
		for i, p := range pos {
			out[i] = store.ListItem{ID: rowID(byte(i + 1)), Position: p}
		}
		return out
	}
	q := &positions{set: map[pgtype.UUID]float64{}}
	ctx := context.Background()
	third := uuid(rowID(3))
	first := uuid(rowID(1))

	if p, _ := moveTo(ctx, q, items(1, 2, 3), rowID(1), nil); p != 4 {
		t.Errorf("to the end = %v", p)
	}
	if p, _ := moveTo(ctx, q, items(1, 2, 3), rowID(1), &third); p != 2.5 {
		t.Errorf("between 2 and 3 = %v", p)
	}
	if p, _ := moveTo(ctx, q, items(1, 2, 3), rowID(3), &first); p != 0 {
		t.Errorf("before the first = %v", p)
	}
	if _, err := moveTo(ctx, q, items(1, 2), rowID(1), new(uuid(rowID(9)))); err == nil {
		t.Error("before a row of another list moved")
	}
	if len(q.set) != 0 {
		t.Fatalf("renumbered with room left: %v", q.set)
	}

	// No room between 1 and 1+1e-9: the others are numbered 1, 3 and the row goes to 2.
	p, err := moveTo(ctx, q, items(1, 1+1e-9, 5), rowID(3), new(uuid(rowID(2))))
	if err != nil || p != 2 || q.set[rowID(1)] != 1 || q.set[rowID(2)] != 3 {
		t.Errorf("renumbered = %v %v, %v", p, err, q.set)
	}
}
