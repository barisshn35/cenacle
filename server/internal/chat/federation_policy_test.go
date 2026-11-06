// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/store"
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

// Every spelling of a listed server is the same server: case, the root dot,
// IDNA and the scheme's default port do not get past a deny list.
func TestFederationPolicyHostSpellings(t *testing.T) {
	servers := []string{"evil.example", "*.bad.example", "xn--bcher-kva.example", "ported.example:443"}
	for _, raw := range []string{
		"https://evil.example./", "https://EVIL.example.:443/x", "http://evil.example..", "https://x.bad.example./",
		"https://bücher.example/", "https://BÜCHER.example./", "https://ported.example/", "https://ported.example.:443",
	} {
		host := policyHost(raw)
		if federationAllows("deny", servers, host) {
			t.Errorf("deny list lets %s through (as %q)", raw, host)
		}
		if !federationAllows("allow", servers, host) {
			t.Errorf("allow list refuses %s (as %q)", raw, host)
		}
	}
	for raw, want := range map[string]string{
		"https://Chat.Example.com.": "chat.example.com:443", "http://chat.example.com:8080/": "chat.example.com:8080",
		"https://[::1]/": "[::1]:443", "https://./": "", "%": "",
	} {
		if got := policyHost(raw); got != want {
			t.Errorf("policyHost(%q) = %q, want %q", raw, got, want)
		}
	}
	if !federationAllows("deny", servers, policyHost("https://ported.example:8443")) {
		t.Error("a port-specific entry refuses another port")
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
