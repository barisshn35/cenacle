// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"testing"

	"github.com/barisshn35/cenacle/server/internal/store"
)

func TestFederationAllows(t *testing.T) {
	servers := []string{"chat.example.com", "*.partner.org", "10.0.0.5:8443"}
	for host, want := range map[string]bool{
		"chat.example.com": true, "chat.example.com:443": true, "eu.partner.org": true, "partner.org": false,
		"10.0.0.5:8443": true, "10.0.0.5": false, "other.example.com": false,
	} {
		if got := federationAllows("allow", servers, host); got != want {
			t.Errorf("allow %s = %v", host, got)
		}
		if got := federationAllows("deny", servers, host); got == want {
			t.Errorf("deny %s = %v", host, got)
		}
		if !federationAllows("open", servers, host) {
			t.Errorf("open %s refused", host)
		}
	}
	if serverHost("https://Chat.Example.com:8443/x") != "chat.example.com:8443" {
		t.Error("serverHost")
	}
}

func TestConnectionTakes(t *testing.T) {
	c := store.FederationConnection{ReceiveMessages: true}
	for typ, want := range map[string]bool{
		"message.created": true, "message.updated": false, "message.deleted": false,
		"reaction.added": false, "channel.offered": true,
	} {
		if takes(c, typ) != want {
			t.Errorf("takes %s = %v", typ, !want)
		}
	}
}
