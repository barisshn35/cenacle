// SPDX-License-Identifier: AGPL-3.0-only
package realtime

import (
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/events"
)

// Operator: go test ./internal/realtime -run TestCallAudience
func TestCallAudience(t *testing.T) {
	a := audience{channels: map[string]string{"allowed": "workspace"}}
	for _, kind := range []string{events.CallRinging, events.CallStarted, events.CallJoined, events.CallLeft, events.CallEnded, events.CallParticipants} {
		data := eventData{ChannelID: "allowed"}
		if !a.allowsData(kind, &data) {
			t.Errorf("member denied %s", kind)
		}
		data.ChannelID = "private"
		if a.allowsData(kind, &data) {
			t.Errorf("nonmember received %s", kind)
		}
	}
}
