// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

func TestFederationControls(t *testing.T) {
	sh := newShared(t)
	acme := newStack(t, sh, options{})
	partner := newStack(t, sh, options{})
	admin := acme.admin()
	ayse := acme.user("sub-ayse", "Ayşe")
	partnerWS := partner.newWorkspace(admin, "Partner")
	const path = "/api/admin/federation-policy"

	if status, _ := problemCode(t, acme, http.MethodPut, path, ayse, api.FederationPolicy{Mode: "deny", Servers: []string{}}); status != http.StatusForbidden {
		t.Errorf("member sets the policy = %d", status)
	}
	if status, _ := problemCode(t, acme, http.MethodPut, path, admin, api.FederationPolicy{Mode: "deny", Servers: []string{"not a host"}}); status != http.StatusBadRequest {
		t.Errorf("bad server = %d", status)
	}
	// Both test servers are 127.0.0.1 (on different ports).
	var pol api.FederationPolicy
	if res := acme.call(http.MethodPut, path, admin, api.FederationPolicy{Mode: "allow", Servers: []string{"Partner.example.com", "*.example.org"}}, &pol); res.StatusCode != http.StatusOK || pol.Servers[0] != "partner.example.com" {
		t.Fatalf("set = %d %+v", res.StatusCode, pol)
	}
	invite := func() string {
		var inv struct{ Code string }
		if res := acme.call(http.MethodPost, "/api/workspaces/"+acme.defaultWS+"/federation/invites", admin, map[string]any{"name": "Partner Inc"}, &inv); res.StatusCode != http.StatusCreated {
			t.Fatalf("invite = %d", res.StatusCode)
		}
		return inv.Code
	}
	connect := "/api/workspaces/" + partnerWS + "/federation/connections"
	if status, code := problemCode(t, partner, http.MethodPost, connect, admin, map[string]any{"code": invite(), "name": "Acme"}); status != http.StatusForbidden || code != "federation_not_allowed" {
		t.Errorf("connect to an unlisted server = %d %s", status, code)
	}
	acme.call(http.MethodPut, path, admin, api.FederationPolicy{Mode: "allow", Servers: []string{"127.0.0.1"}}, nil)
	var conn api.FederationConnection
	if res := partner.call(http.MethodPost, connect, admin, map[string]any{"code": invite(), "name": "Acme"}, &conn); res.StatusCode != http.StatusCreated {
		t.Fatalf("connect to a listed server = %d", res.StatusCode)
	}
	if conn.Policy == nil || !conn.Policy.ReceiveMessages || conn.Policy.RequestsPerMinute != 120 {
		t.Errorf("default connection policy = %+v", conn.Policy)
	}

	// What a connection takes in; it shows in the federation activity.
	var changed api.FederationConnection
	res := partner.call(http.MethodPatch, "/api/federation/connections/"+conn.Id.String(), admin, map[string]any{
		"policy": api.ConnectionPolicy{ReceiveMessages: true, ReceiveReactions: false, ReceiveEdits: false, RequestsPerMinute: 30},
	}, &changed)
	if res.StatusCode != http.StatusOK || changed.Policy.ReceiveReactions || changed.Policy.RequestsPerMinute != 30 || changed.Status != "active" {
		t.Fatalf("set connection policy = %d %+v", res.StatusCode, changed)
	}
	if status, _ := problemCode(t, partner, http.MethodPatch, "/api/federation/connections/"+conn.Id.String(), admin, map[string]any{
		"policy": api.ConnectionPolicy{RequestsPerMinute: 0},
	}); status != http.StatusBadRequest {
		t.Errorf("zero rate = %d", status)
	}
	var activity struct{ Events []api.AuditEvent }
	partner.call(http.MethodGet, "/api/workspaces/"+partnerWS+"/audit?prefix=federation.", admin, nil, &activity)
	if len(activity.Events) == 0 {
		t.Fatal("no federation activity")
	}
	for _, e := range activity.Events {
		if !strings.HasPrefix(e.Action, "federation.") {
			t.Errorf("activity has %s", e.Action)
		}
	}

	// Leaving the server out again stops the connection's deliveries.
	acme.call(http.MethodPut, path, admin, api.FederationPolicy{Mode: "deny", Servers: []string{"127.0.0.1"}}, nil)
	var ch struct{ ID string }
	if res := partner.call(http.MethodPost, "/api/channels", admin, map[string]any{"workspace_id": partnerWS, "name": "ortak"}, &ch); res.StatusCode != http.StatusCreated {
		t.Fatalf("channel = %d", res.StatusCode)
	}
	if res := partner.call(http.MethodPost, "/api/channels/"+ch.ID+"/shares", admin, map[string]any{"connection_id": conn.Id}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("share = %d", res.StatusCode)
	}
	federate(t, partner, acme)
	var fed federation
	partner.call(http.MethodGet, "/api/workspaces/"+partnerWS+"/federation", admin, nil, &fed)
	if len(fed.Connections) != 1 || !strings.Contains(fed.Connections[0].LastError, "does not allow") {
		t.Errorf("connection after deny = %+v", fed.Connections)
	}
}
