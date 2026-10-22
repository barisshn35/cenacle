// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/realtime"
)

type auditEvent struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Actor  *struct {
		DisplayName string `json:"display_name"`
	} `json:"actor"`
	TargetID string         `json:"target_id"`
	Detail   map[string]any `json:"detail"`
}

func TestAuditLogRecordsSecurityRelevantActions(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	ops := s.newWorkspace(admin, "Operasyon")
	s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ops, map[string]any{"max_uses": 5})+"/accept", ayse, nil, nil)
	s.call(http.MethodPatch, "/api/workspaces/"+ops+"/members/"+s.userID(ayse), admin, map[string]string{"role": "admin"}, nil)

	var ch channel
	s.call(http.MethodPost, "/api/channels", ayse, map[string]any{"workspace_id": ops, "name": "Nöbet"}, &ch)
	s.call(http.MethodPost, "/api/channels/"+ch.ID+"/archive", ayse, nil, nil)

	path := "/api/workspaces/" + ops + "/audit"
	var page struct {
		Events  []auditEvent `json:"events"`
		HasMore bool         `json:"has_more"`
	}
	if res := s.call(http.MethodGet, path, admin, nil, &page); res.StatusCode != http.StatusOK {
		t.Fatalf("audit = %d", res.StatusCode)
	}
	var actions []string
	for _, e := range page.Events {
		actions = append(actions, e.Action)
	}
	want := []string{
		"channel.archived", "channel.created", "workspace.role_changed", "invite.accepted",
		"invite.created", "workspace.created",
	}
	if len(actions) != len(want) {
		t.Fatalf("actions = %v, want %v", actions, want)
	}
	for i := range want {
		if actions[i] != want[i] {
			t.Fatalf("actions = %v, want %v", actions, want)
		}
	}
	if role := page.Events[2]; role.Actor == nil || role.Actor.DisplayName != "Yönetici" || role.Detail["to"] != "admin" {
		t.Errorf("role change = %+v", role)
	}

	// Paging with a cursor.
	s.call(http.MethodGet, path+"?limit=2", admin, nil, &page)
	if len(page.Events) != 2 || !page.HasMore {
		t.Fatalf("first page = %+v", page)
	}
	s.call(http.MethodGet, path+"?limit=10&before="+page.Events[1].ID, admin, nil, &page)
	if len(page.Events) != 4 || page.HasMore || page.Events[0].Action != "workspace.role_changed" {
		t.Errorf("second page = %+v", page)
	}

	// Only owners and admins read it; outsiders do not see the workspace.
	s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ops, map[string]any{})+"/accept", mert, nil, nil)
	if status, _ := problemCode(t, s, http.MethodGet, path, mert, nil); status != http.StatusForbidden {
		t.Errorf("member reading the audit log = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/workspaces/"+ops+"/audit", s.user("sub-z", "Zeynep"), nil); status != http.StatusNotFound {
		t.Errorf("outsider reading the audit log = %d", status)
	}
}

func TestEndingSessionsClosesTheirConnectionsAtOnce(t *testing.T) {
	// Periodic checks are far away: closing must come from the notice.
	s := newStack(t, newShared(t), options{settings: realtime.Settings{
		Heartbeat: time.Minute, SessionCheck: time.Hour, QueueSize: 64, MaxBacklog: 50,
	}})
	laptop := s.user("sub-a", "Ayşe")
	phone := s.userWithEmail("sub-a", "Ayşe", "sub-a@example.com") // a second session
	laptopConn := s.connect(laptop, "")
	read(t, laptopConn)
	phoneConn := s.connect(phone, "")
	read(t, phoneConn)

	if res := s.call(http.MethodPost, "/api/sessions/end-all", laptop, map[string]bool{"keep_current": true}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end others = %d", res.StatusCode)
	}
	start := time.Now()
	if code := closeStatus(t, phoneConn); code != realtime.CloseSessionEnded {
		t.Errorf("phone closed with %d, want %d", code, realtime.CloseSessionEnded)
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("closing took %s", time.Since(start))
	}
	// The laptop stays connected: a message still arrives.
	sent, _ := s.send(laptop, s.general(laptop), "hâlâ buradayım", "still-here-1")
	if ev := read(t, laptopConn); ev.Type != "message.created" || !strings.Contains(string(ev.Data), sent.ID) {
		t.Errorf("laptop event = %+v", ev)
	}
}
