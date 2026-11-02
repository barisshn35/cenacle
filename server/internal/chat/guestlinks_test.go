// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"
)

// Guest-password checks run Argon2id within a memory budget across the
// server, however many joins arrive at once; a check that finds no room in
// time fails as busy instead of piling up memory.
func TestGuestPasswordHashingIsBounded(t *testing.T) {
	encoded, err := hashGuestPassword(context.Background(), "the-link-password")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := checkGuestPassword(context.Background(), encoded, "the-link-password"); !ok || err != nil {
		t.Fatalf("right password = %v %v", ok, err)
	}

	var running, peak atomic.Int64
	guestArgon = func(password, salt []byte, time_, memory uint32, threads uint8, keyLen uint32) []byte {
		n := running.Add(1)
		for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
		}
		defer running.Add(-1)
		time.Sleep(20 * time.Millisecond)
		return argon2.IDKey(password, salt, 1, 64, threads, keyLen)
	}
	t.Cleanup(func() { guestArgon = argon2.IDKey })

	var wg sync.WaitGroup
	for range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := checkGuestPassword(context.Background(), encoded, "wrong-guess"); ok || err != nil {
				t.Errorf("wrong password = %v %v", ok, err)
			}
		}()
	}
	wg.Wait()
	if max := int64(guestHashBudget / argonMemory); peak.Load() > max || peak.Load() == 0 {
		t.Errorf("%d hashes ran at once, want 1 to %d", peak.Load(), max)
	}

	// With no room left, a check gives up when its request does.
	if err := guestHashing.Acquire(context.Background(), guestHashBudget); err != nil {
		t.Fatal(err)
	}
	defer guestHashing.Release(guestHashBudget)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := checkGuestPassword(ctx, encoded, "wrong-guess"); !errors.Is(err, errHashBusy) {
		t.Errorf("check without room = %v", err)
	}
}
