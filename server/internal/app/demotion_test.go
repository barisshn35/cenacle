// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/groups"
)

// presenceOf waits for the next presence.changed of someone else than self
// and returns whose it was.
func presenceOf(t *testing.T, c *websocket.Conn, self string) string {
	t.Helper()
	for {
		var p presence
		_ = json.Unmarshal(readEphemeral(t, c, "presence.changed").Data, &p)
		if p.UserID != self {
			return p.UserID
		}
	}
}

// A member made a guest by the directory hears, on the connection opened
// before, only of the people a guest may see.
func TestDemotedToGuestConnectionFollowsGuestRule(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	g := newGuestScene(s)
	demoted := s.signInWith("sub-demoted", "Demoted", groups.Profile{})
	demotedID := s.userID(demoted)
	if res := s.call(http.MethodPost, "/api/channels/"+g.partners.ID+"/members", g.admin, map[string]string{"user_id": demotedID}, nil); res.StatusCode >= 300 {
		t.Fatalf("add member = %d", res.StatusCode)
	}
	hiddenConn := s.connect(g.hidden, "")
	read(t, hiddenConn)
	friendConn := s.connect(g.friend, "")
	read(t, friendConn)
	conn := s.connect(demoted, "")
	read(t, conn)
	time.Sleep(300 * time.Millisecond)

	s.applyProfile("sub-demoted", groups.Profile{Role: "guest"})
	readFrame(t, conn, func(f frame) bool { return f.Type == "channel.left" })
	time.Sleep(500 * time.Millisecond) // the rest of the change reaches the connection

	s.call(http.MethodPut, "/api/presence", g.hidden, map[string]string{"status": "away"}, nil)
	s.call(http.MethodPut, "/api/presence", g.friend, map[string]string{"status": "dnd"}, nil)
	if who := presenceOf(t, conn, demotedID); who != s.userID(g.friend) {
		t.Errorf("the demoted guest heard first of %s (hidden is %s)", who, s.userID(g.hidden))
	}
}

// A spillage reviewer the directory makes a guest reviews no more.
func TestSpillageReviewerDemotedToGuest(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	owner := s.admin()
	rev := s.signInWith("sub-rev", "Rev", groups.Profile{})
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	if res := s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/spillage-reviewers", owner, map[string]any{"user_ids": []string{s.userID(rev)}}, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("reviewers = %d", res.StatusCode)
	}
	m, _ := s.send(ayse, general, "REVIEW-DUMMY", "guard-sr-nonce-1")
	var rep api.SpillageReport
	s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/spillage", ayse, map[string]string{"reason": "secret"}, &rep)

	s.applyProfile("sub-rev", groups.Profile{Role: "guest"})
	queue := "/api/workspaces/" + s.defaultWS + "/spillage?status=open"
	if status, _ := problemCode(t, s, http.MethodGet, queue, rev, nil); status != http.StatusForbidden {
		t.Errorf("demoted reviewer reads the queue = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/spillage/"+rep.Id.String()+"/decision", rev, map[string]string{"decision": "dismiss"}); status != http.StatusForbidden {
		t.Errorf("demoted reviewer decides = %d", status)
	}
	var reviewers []string
	_ = s.pool.QueryRow(context.Background(), `SELECT spillage_reviewers::text[] FROM workspaces WHERE id = $1`, s.defaultWS).Scan(&reviewers)
	if len(reviewers) != 0 {
		t.Errorf("reviewers left: %v", reviewers)
	}
}
