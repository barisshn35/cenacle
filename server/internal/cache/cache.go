// SPDX-License-Identifier: Apache-2.0

// Package cache wraps the Valkey client.
package cache

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/valkey-io/valkey-go"
)

// Client connects to Valkey lazily: valkey-go dials during construction, and
// the server must be able to start (and report "not ready") while Valkey is down.
type Client struct {
	opt valkey.ClientOption

	mu     sync.Mutex
	client valkey.Client
}

// New returns a lazily connecting client.
func New(addr, password string) *Client {
	return &Client{opt: valkey.ClientOption{
		InitAddress:  []string{addr},
		Password:     password,
		ClientName:   "cenacle-server",
		DisableCache: true, // client-side caching is not used yet
	}}
}

// Get returns the underlying client, connecting on first use.
func (c *Client) Get() (valkey.Client, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.client != nil {
		return c.client, nil
	}
	vc, err := valkey.NewClient(c.opt)
	if err != nil {
		return nil, err
	}
	c.client = vc
	return vc, nil
}

// Close releases the connection, if any.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.client != nil {
		c.client.Close()
		c.client = nil
	}
}

// Name implements health.Checker.
func (*Client) Name() string { return "valkey" }

// Check implements health.Checker with a PING.
func (c *Client) Check(ctx context.Context) error {
	vc, err := c.Get()
	if err != nil {
		return err
	}
	return vc.Do(ctx, vc.B().Ping().Build()).Error()
}

// ErrNotFound is returned by Take for missing or expired keys.
var ErrNotFound = errors.New("cache: key not found")

// PutNew stores value under key for ttl unless the key exists.
func (c *Client) PutNew(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	vc, err := c.Get()
	if err != nil {
		return err
	}
	cmd := vc.B().Set().Key(key).Value(valkey.BinaryString(value)).Nx().Px(ttl).Build()
	if err := vc.Do(ctx, cmd).Error(); err != nil {
		if valkey.IsValkeyNil(err) {
			return fmt.Errorf("cache: key %q exists", key)
		}
		return err
	}
	return nil
}

// Take returns and deletes the value under key (GETDEL), so a value can be
// used once only.
func (c *Client) Take(ctx context.Context, key string) ([]byte, error) {
	vc, err := c.Get()
	if err != nil {
		return nil, err
	}
	b, err := vc.Do(ctx, vc.B().Getdel().Key(key).Build()).AsBytes()
	if valkey.IsValkeyNil(err) {
		return nil, ErrNotFound
	}
	return b, err
}

// Hit counts an event in a fixed window and returns the count so far and the
// time until the window ends (rate limiting).
func (c *Client) Hit(ctx context.Context, key string, window time.Duration) (int64, time.Duration, error) {
	vc, err := c.Get()
	if err != nil {
		return 0, 0, err
	}
	res := vc.DoMulti(ctx,
		vc.B().Incr().Key(key).Build(),
		vc.B().Pexpire().Key(key).Milliseconds(window.Milliseconds()).Nx().Build(),
		vc.B().Pttl().Key(key).Build(),
	)
	n, err := res[0].AsInt64()
	if err != nil {
		return 0, 0, err
	}
	ttl, err := res[2].AsInt64()
	if err != nil {
		return 0, 0, err
	}
	return n, time.Duration(ttl) * time.Millisecond, nil
}
