// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/valkey-io/valkey-go"
)

// Short-lived event types: delivered to connected clients only, never
// stored or resumed (Valkey pub/sub).
const (
	Typing          = "typing"
	PresenceChanged = "presence.changed"
	// SessionsEnded tells the connections of a user that some of their
	// sessions ended (signed out elsewhere); each checks its own at once.
	SessionsEnded = "sessions.ended"
)

// Ephemeral publishes and receives short-lived events. An event without an
// ID is ephemeral.
type Ephemeral struct {
	Valkey ValkeyClient
	// Channel is the pub/sub channel, e.g. "cenacle:ephemeral".
	Channel string
}

// Publish sends an event to every instance; nobody may be listening.
func (e *Ephemeral) Publish(ctx context.Context, typ string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(payload{Type: typ, Data: raw})
	vc, err := e.Valkey.Get()
	if err != nil {
		return err
	}
	if err := vc.Do(ctx, vc.B().Publish().Channel(e.Channel).Message(string(body)).Build()).Error(); err != nil {
		return fmt.Errorf("publish %s: %w", typ, err)
	}
	return nil
}

// Subscribe calls fn for every event published until ctx ends or the
// subscription fails.
func (e *Ephemeral) Subscribe(ctx context.Context, fn func(Event)) error {
	vc, err := e.Valkey.Get()
	if err != nil {
		return err
	}
	return vc.Receive(ctx, vc.B().Subscribe().Channel(e.Channel).Build(), func(msg valkey.PubSubMessage) {
		var p payload
		if json.Unmarshal([]byte(msg.Message), &p) != nil {
			return
		}
		fn(Event{Type: p.Type, Data: p.Data})
	})
}
