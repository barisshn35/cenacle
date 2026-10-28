// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/auth"
)

// renames counts the calls; slow ones wait until they are given up.
type renames struct {
	calls atomic.Int32
	slow  atomic.Bool
}

func (r *renames) FollowRenames(ctx context.Context) error {
	r.calls.Add(1)
	if r.slow.Load() {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}

// A sign-in with an identity provider's groups first follows their renames at
// Cenacle ID (ADR 0046), so mappings do not take memberships back and give
// them again; it waits a little at most and never fails because of them.
func TestSignInFollowsGroupRenames(t *testing.T) {
	e := newEnv(t)
	r := &renames{}
	e.handlers.GroupRenames = r

	// Only a directory's groups: nothing a provider rename moves.
	e.idp.Groups = []string{"Engineering"}
	e.signIn(newClient(t), "/api/auth/login")
	if n := r.calls.Load(); n != 0 {
		t.Errorf("directory groups only: %d calls", n)
	}
	e.idp.Groups = []string{"Engineering", "Acme/Design"}
	e.signIn(newClient(t), "/api/auth/login")
	if n := r.calls.Load(); n != 1 {
		t.Errorf("provider groups: %d calls, want 1", n)
	}

	// Cenacle ID does not answer: the sign-in goes on after the timeout.
	r.slow.Store(true)
	start := time.Now()
	e.signIn(newClient(t), "/api/auth/login")
	if took := time.Since(start); took < auth.RenamesTimeout || took > auth.RenamesTimeout+5*time.Second {
		t.Errorf("sign-in took %s", took)
	}
	if n := r.calls.Load(); n != 2 {
		t.Errorf("calls = %d, want 2", n)
	}
}
