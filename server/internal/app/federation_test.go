// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/chat"
)

// federate sends what both servers have queued for each other, until quiet.
func federate(t *testing.T, servers ...*stack) {
	t.Helper()
	for range 5 {
		n := 0
		for _, s := range servers {
			sent, err := s.federation.Run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			n += sent
		}
		if n == 0 {
			return
		}
	}
}

type federation struct {
	Connections []api.FederationConnection
	Offers      []api.ChannelOffer
}

func TestFederatedChannel(t *testing.T) {
	sh := newShared(t)
	// Two servers (one database, two workspaces): Acme here, Partner there.
	acme := newStack(t, sh, options{})
	partner := newStack(t, sh, options{})
	admin := acme.admin()
	ayse := acme.user("sub-ayse", "Ayşe")
	general := acme.general(ayse)
	partnerWS := partner.newWorkspace(admin, "Partner")

	var inv struct{ Code string }
	if res := acme.call(http.MethodPost, "/api/workspaces/"+acme.defaultWS+"/federation/invites", admin, map[string]any{"name": "Partner Inc"}, &inv); res.StatusCode != http.StatusCreated {
		t.Fatalf("invite = %d", res.StatusCode)
	}
	if status, _ := problemCode(t, partner, http.MethodPost, "/api/workspaces/"+partnerWS+"/federation/connections", admin, map[string]any{"code": "nonsense", "name": "Acme"}); status != http.StatusBadRequest {
		t.Errorf("bad code = %d", status)
	}
	var conn api.FederationConnection
	if res := partner.call(http.MethodPost, "/api/workspaces/"+partnerWS+"/federation/connections", admin, map[string]any{"code": inv.Code, "name": "Acme"}, &conn); res.StatusCode != http.StatusCreated || conn.Status != "active" {
		t.Fatalf("connect = %d %+v", res.StatusCode, conn)
	}
	// The code works once.
	if status, _ := problemCode(t, partner, http.MethodPost, "/api/workspaces/"+partnerWS+"/federation/connections", admin, map[string]any{"code": inv.Code, "name": "Again"}); status != http.StatusBadGateway {
		t.Errorf("reused code = %d", status)
	}
	var here federation
	acme.call(http.MethodGet, "/api/workspaces/"+acme.defaultWS+"/federation", admin, nil, &here)
	if len(here.Connections) != 1 || here.Connections[0].Status != "active" || here.Connections[0].Name != "Partner Inc" {
		t.Fatalf("acme connections = %+v", here.Connections)
	}
	acmeConn := here.Connections[0].Id.String()

	// Share General; Partner's admin accepts it.
	if status, _ := problemCode(t, acme, http.MethodPost, "/api/channels/"+general+"/shares", ayse, map[string]any{"connection_id": acmeConn}); status != http.StatusForbidden {
		t.Errorf("member shares = %d", status)
	}
	if res := acme.call(http.MethodPost, "/api/channels/"+general+"/shares", admin, map[string]any{"connection_id": acmeConn}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("share = %d", res.StatusCode)
	}
	federate(t, acme, partner)
	var there federation
	partner.call(http.MethodGet, "/api/workspaces/"+partnerWS+"/federation", admin, nil, &there)
	if len(there.Offers) != 1 || there.Offers[0].Name != "General" {
		t.Fatalf("offers = %+v", there.Offers)
	}
	var mirror api.Channel
	if res := partner.call(http.MethodPost, "/api/federation/offers/"+there.Offers[0].Id.String()+"/accept", admin, nil, &mirror); res.StatusCode != http.StatusCreated {
		t.Fatalf("accept = %d", res.StatusCode)
	}
	federate(t, acme, partner)
	var shares struct{ Shares []api.ChannelShare }
	acme.call(http.MethodGet, "/api/channels/"+general+"/shares", ayse, nil, &shares)
	if len(shares.Shares) != 1 || shares.Shares[0].Status != "active" {
		t.Fatalf("shares = %+v", shares.Shares)
	}

	// Messages go over, with their author named after their server.
	mertID := acme.userID(admin)
	hello, _ := acme.send(ayse, general, "Hello <@"+mertID+">, the plan is ready", "fed-nonce-1")
	federate(t, acme, partner)
	got := partner.timeline(admin, mirror.Id.String())
	if len(got) != 1 || got[0].Author.DisplayName != "Ayşe (Acme)" || got[0].Body != "Hello @Yönetici, the plan is ready" {
		t.Fatalf("partner sees %+v", got)
	}
	theirs := got[0].Id.String()

	// A reply there lands in the thread here; a reaction too.
	partner.reply(admin, mirror.Id.String(), theirs, "Thanks!", "fed-nonce-2", false)
	partner.call(http.MethodPut, "/api/channels/"+mirror.Id.String()+"/messages/"+theirs+"/reactions/"+url.PathEscape("👍"), admin, nil, nil)
	federate(t, acme, partner)
	var replies api.MessagePage
	acme.call(http.MethodGet, "/api/channels/"+general+"/messages/"+hello.ID+"/replies", ayse, nil, &replies)
	if len(replies.Messages) != 1 || replies.Messages[0].Body != "Thanks!" || !strings.HasSuffix(replies.Messages[0].Author.DisplayName, "(Partner Inc)") {
		t.Fatalf("replies here = %+v", replies.Messages)
	}
	mine := acme.timeline(ayse, general)
	var reactions int
	for _, m := range mine {
		if m.Id.String() == hello.ID {
			reactions = len(m.Reactions)
		}
	}
	if reactions != 1 {
		t.Errorf("reactions here = %d", reactions)
	}

	// Edits and deletions follow; nothing echoes back.
	acme.call(http.MethodPatch, "/api/channels/"+general+"/messages/"+hello.ID, ayse, map[string]any{"body": "The plan moved"}, nil)
	federate(t, acme, partner)
	if got := partner.timeline(admin, mirror.Id.String()); got[0].Body != "The plan moved" {
		t.Errorf("edited there = %q", got[0].Body)
	}
	acme.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+hello.ID, ayse, nil, nil)
	federate(t, acme, partner)
	if got := partner.timeline(admin, mirror.Id.String()); len(got) != 0 {
		t.Errorf("deleted message still there: %d", len(got))
	}
	if n := acme.count(`SELECT count(*) FROM federation_deliveries`); n != 0 {
		t.Errorf("deliveries left = %d", n)
	}

	// Unsigned or wrongly signed requests are refused.
	req, _ := http.NewRequest(http.MethodPost, acme.srv.URL+"/api/federation/v1/events", bytes.NewReader([]byte(`{"events":[]}`)))
	req.Header.Set(chat.FederationHeader, "c="+acmeConn+",t=1,v1=00")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("forged events = %d", res.StatusCode)
	}
}
