// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"
)

const LeaseTTL = 15 * time.Second

type Valkey interface{ Get() (valkey.Client, error) }

// Lease fences restarted processes. A lost lease is terminal: callers close
// every transport and start a fresh process generation instead of resurrecting
// rooms another process may already have reconciled.
type Lease struct {
	Cache      Valkey
	NodeID     string
	Generation string
	ready      atomic.Bool
}

var renewLease = valkey.NewLuaScriptNoSha(`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], 15000)`)
var releaseLease = valkey.NewLuaScriptNoSha(`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`)

func (l *Lease) Name() string { return "media-lease" }
func (l *Lease) Check(context.Context) error {
	if !l.ready.Load() {
		return errors.New("media lease unavailable")
	}
	return nil
}
func (l *Lease) key() string { return "cenacle:media:node:" + l.NodeID }

func (l *Lease) Run(ctx context.Context) error {
	if l.Cache == nil || l.NodeID == "" || l.Generation == "" {
		return errors.New("invalid media lease configuration")
	}
	if _, err := uuid.Parse(l.Generation); err != nil {
		return errors.New("invalid media generation")
	}
	client, err := l.Cache.Get()
	if err != nil {
		return errors.New("media lease unavailable")
	}
	if err = client.Do(ctx, client.B().Set().Key(l.key()).Value(l.Generation).Nx().Px(LeaseTTL).Build()).Error(); err != nil {
		return errors.New("media node already owned or unavailable")
	}
	l.ready.Store(true)
	defer l.ready.Store(false)
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = releaseLease.Exec(releaseCtx, client, []string{l.key()}, []string{l.Generation}).Error()
	}()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			renewCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			n, err := renewLease.Exec(renewCtx, client, []string{l.key()}, []string{l.Generation}).AsInt64()
			cancel()
			if err != nil || n != 1 {
				return errors.New("media lease lost")
			}
		}
	}
}

// ClaimRoom only assigns a room while this node's generation still owns its
// lease. Existing rooms are accepted only for the same generation.
func (l *Lease) ClaimRoom(ctx context.Context, callID string) error {
	if _, err := uuid.Parse(callID); err != nil {
		return ErrAdmission
	}
	if !l.ready.Load() {
		return ErrAdmission
	}
	client, err := l.Cache.Get()
	if err != nil {
		return ErrAdmission
	}
	key := "cenacle:media:room:" + callID
	owner := l.NodeID + ":" + l.Generation
	// Node and room are checked separately because deployments may use Valkey
	// cluster slots. The node generation is also rechecked by admission.
	current, err := client.Do(ctx, client.B().Get().Key(l.key()).Build()).ToString()
	if err != nil || current != l.Generation {
		return ErrAdmission
	}
	n, err := claimRoom.Exec(ctx, client, []string{key}, []string{owner}).AsInt64()
	if err != nil || n != 1 {
		return ErrAdmission
	}
	return nil
}

var claimRoom = valkey.NewLuaScriptNoSha(`
local owner = redis.call('GET', KEYS[1])
if owner and owner ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', 15000)
return 1`)
