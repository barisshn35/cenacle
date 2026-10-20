// SPDX-License-Identifier: Apache-2.0

// Package cache wraps the Valkey client.
package cache

import (
	"context"
	"sync"

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
