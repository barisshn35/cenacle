// SPDX-License-Identifier: Apache-2.0

package app_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/chat"
)

type workspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsDefault bool   `json:"is_default"`
	Role      string `json:"role"`
}

func (s *stack) workspaces(token string) []workspace {
	s.t.Helper()
	var out struct{ Workspaces []workspace }
	if res := s.call(http.MethodGet, "/api/workspaces", token, nil, &out); res.StatusCode != http.StatusOK {
		s.t.Fatalf("workspaces = %d", res.StatusCode)
	}
	return out.Workspaces
}

// newWorkspace has the administrator create a workspace and returns its id.
func (s *stack) newWorkspace(admin, name string) string {
	s.t.Helper()
	var ws workspace
	if res := s.call(http.MethodPost, "/api/workspaces", admin, map[string]string{"name": name}, &ws); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("create workspace = %d", res.StatusCode)
	}
	return ws.ID
}

// invite creates an invitation and returns its token.
func (s *stack) invite(token, wsID string, body map[string]any) string {
	s.t.Helper()
	var out struct {
		Token string `json:"token"`
	}
	if res := s.call(http.MethodPost, "/api/workspaces/"+wsID+"/invites", token, body, &out); res.StatusCode != http.StatusCreated {
		s.t.Fatalf("create invite = %d", res.StatusCode)
	}
	return out.Token
}

func TestWorkspacesAndInvitations(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")

	// Everyone is in the default workspace; the administrator owns it.
	if ws := s.workspaces(ayse); len(ws) != 1 || !ws[0].IsDefault || ws[0].Role != "member" {
		t.Fatalf("Ayşe's workspaces = %+v", ws)
	}
	if ws := s.workspaces(admin); ws[0].Role != "owner" {
		t.Errorf("administrator's role = %s", ws[0].Role)
	}

	// Only the instance administrator creates workspaces; a General channel comes with it.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workspaces", ayse, map[string]string{"name": "X"}); status != http.StatusForbidden {
		t.Errorf("member creating a workspace = %d", status)
	}
	ops := s.newWorkspace(admin, "Operasyon")
	var dir struct{ Channels []channel }
	s.call(http.MethodGet, "/api/channels/directory?workspace_id="+ops, admin, nil, &dir)
	if len(dir.Channels) != 1 || dir.Channels[0].Name != "General" || !dir.Channels[0].IsMember {
		t.Fatalf("new workspace channels = %+v", dir.Channels)
	}
	opsGeneral := dir.Channels[0].ID

	// Outsiders do not see it at all.
	if status, _ := problemCode(t, s, http.MethodGet, "/api/channels/directory?workspace_id="+ops, ayse, nil); status != http.StatusNotFound {
		t.Errorf("outsider listing = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/channels/"+opsGeneral+"/messages", ayse, nil); status != http.StatusNotFound {
		t.Errorf("outsider reading = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+opsGeneral+"/members", admin,
		map[string]string{"user_id": s.userID(ayse)}); status != http.StatusBadRequest {
		t.Errorf("adding an outsider to a channel = %d", status)
	}

	// An invitation for two people.
	token := s.invite(admin, ops, map[string]any{"expires_in_hours": 24, "max_uses": 2})
	var preview struct {
		WorkspaceName string `json:"workspace_name"`
		Valid         bool   `json:"valid"`
		IsMember      bool   `json:"is_member"`
	}
	s.call(http.MethodGet, "/api/invites/"+token, ayse, nil, &preview)
	if preview.WorkspaceName != "Operasyon" || !preview.Valid || preview.IsMember {
		t.Errorf("preview = %+v", preview)
	}
	var joined workspace
	if res := s.call(http.MethodPost, "/api/invites/"+token+"/accept", ayse, nil, &joined); res.StatusCode != http.StatusOK || joined.Role != "member" {
		t.Fatalf("accept = %d %+v", res.StatusCode, joined)
	}
	// Accepting again changes nothing (and does not count a use).
	s.call(http.MethodPost, "/api/invites/"+token+"/accept", ayse, nil, nil)
	if s.channelID(ayse, "General") == "" {
		t.Fatal("no General")
	}
	found := false
	for _, c := range s.channels(ayse, "/api/channels") {
		found = found || c.ID == opsGeneral
	}
	if !found {
		t.Error("the new member is not in the workspace's General")
	}
	if res := s.call(http.MethodPost, "/api/invites/"+token+"/accept", mert, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("second use = %d", res.StatusCode)
	}
	third := s.user("sub-c", "Can")
	if status, code := problemCode(t, s, http.MethodPost, "/api/invites/"+token+"/accept", third, nil); status != http.StatusGone || code != chat.CodeInviteInvalid {
		t.Errorf("third use of a two-use invite = %d %s", status, code)
	}

	// Revoked and expired invitations do not work; unknown ones do not exist.
	revoked := s.invite(admin, ops, map[string]any{})
	var list struct {
		Invites []struct {
			ID string `json:"id"`
		} `json:"invites"`
	}
	s.call(http.MethodGet, "/api/workspaces/"+ops+"/invites", admin, nil, &list)
	for _, i := range list.Invites {
		s.call(http.MethodDelete, "/api/workspaces/"+ops+"/invites/"+i.ID, admin, nil, nil)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/invites/"+revoked+"/accept", third, nil); status != http.StatusGone {
		t.Errorf("revoked invite = %d", status)
	}
	expired := s.invite(admin, ops, map[string]any{})
	if _, err := s.pool.Exec(context.Background(), "UPDATE workspace_invites SET expires_at = now() - interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/invites/"+expired+"/accept", third, nil); status != http.StatusGone {
		t.Errorf("expired invite = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/invites/nonexistent-token", third, nil); status != http.StatusNotFound {
		t.Errorf("unknown invite = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/workspaces/"+ops+"/invites", ayse, map[string]any{}); status != http.StatusForbidden {
		t.Errorf("member inviting = %d", status)
	}
}

func TestWorkspaceRoles(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	ops := s.newWorkspace(admin, "Operasyon")
	for _, tok := range []string{ayse, mert} {
		s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ops, map[string]any{})+"/accept", tok, nil, nil)
	}
	ayseID, mertID := s.userID(ayse), s.userID(mert)
	members := "/api/workspaces/" + ops + "/members/"

	// A member cannot create channels; an admin can.
	newCh := map[string]any{"workspace_id": ops, "name": "Nöbet"}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels", ayse, newCh); status != http.StatusForbidden {
		t.Errorf("member creating a channel = %d", status)
	}
	s.call(http.MethodPatch, members+ayseID, admin, map[string]string{"role": "admin"}, nil)
	if res := s.call(http.MethodPost, "/api/channels", ayse, newCh, nil); res.StatusCode != http.StatusCreated {
		t.Errorf("admin creating a channel = %d", res.StatusCode)
	}

	// Admins cannot touch owners; owners keep at least one owner.
	if status, _ := problemCode(t, s, http.MethodPatch, members+ayseID, ayse, map[string]string{"role": "owner"}); status != http.StatusForbidden {
		t.Errorf("admin granting owner = %d", status)
	}
	if status, code := problemCode(t, s, http.MethodPatch, members+s.userID(admin), admin, map[string]string{"role": "member"}); status != http.StatusForbidden || code != chat.CodeLastOwner {
		t.Errorf("last owner stepping down = %d %s", status, code)
	}
	if status, code := problemCode(t, s, http.MethodDelete, members+s.userID(admin), admin, nil); status != http.StatusForbidden || code != chat.CodeLastOwner {
		t.Errorf("last owner leaving = %d %s", status, code)
	}

	// Removing someone takes them out of the workspace's channels too.
	if res := s.call(http.MethodDelete, members+mertID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("admin removing a member = %d", res.StatusCode)
	}
	for _, c := range s.channels(mert, "/api/channels") {
		var wsID string
		_ = s.pool.QueryRow(context.Background(), "SELECT workspace_id::text FROM channels WHERE id = $1", c.ID).Scan(&wsID)
		if wsID == ops {
			t.Errorf("still in %s after removal", c.Name)
		}
	}
	// Nobody leaves the default workspace.
	if status, code := problemCode(t, s, http.MethodDelete, "/api/workspaces/"+s.defaultWS+"/members/"+mertID, mert, nil); status != http.StatusForbidden || code != chat.CodeDefaultWorkspace {
		t.Errorf("leaving the default workspace = %d %s", status, code)
	}

	// Members are searched within the workspace only.
	var people struct {
		Users []struct {
			DisplayName string `json:"display_name"`
		} `json:"users"`
	}
	s.call(http.MethodGet, "/api/users?q=mert&workspace_id="+ops, ayse, nil, &people)
	if len(people.Users) != 0 {
		t.Errorf("search found a non-member: %+v", people.Users)
	}
}

func TestChannelManagersAppointManagers(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	var c channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Proje", "visibility": "private"}, &c)
	for _, tok := range []string{ayse, mert} {
		s.call(http.MethodPost, "/api/channels/"+c.ID+"/members", admin, map[string]string{"user_id": s.userID(tok)}, nil)
	}
	path := "/api/channels/" + c.ID + "/members/"
	if status, _ := problemCode(t, s, http.MethodPatch, path+s.userID(mert), ayse, map[string]string{"role": "manager"}); status != http.StatusForbidden {
		t.Errorf("member appointing = %d", status)
	}
	if res := s.call(http.MethodPatch, path+s.userID(ayse), admin, map[string]string{"role": "manager"}, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("appoint = %d", res.StatusCode)
	}
	// Now Ayşe manages the channel and can add people.
	can := s.user("sub-c", "Can")
	if res := s.call(http.MethodPost, "/api/channels/"+c.ID+"/members", ayse, map[string]string{"user_id": s.userID(can)}, nil); res.StatusCode != http.StatusOK {
		t.Errorf("new manager adding = %d", res.StatusCode)
	}
}

func TestEventsStayInTheirWorkspace(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	ops := s.newWorkspace(admin, "Operasyon")

	conn := s.connect(ayse, "")
	read(t, conn) // hello

	// A channel for everyone in a workspace Ayşe is not in: nothing arrives.
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"workspace_id": ops, "name": "Duyuru", "is_default": true}, nil)
	// Joining by invitation: she learns at once, then sees the workspace's events.
	s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ops, map[string]any{})+"/accept", ayse, nil, nil)
	if ev := read(t, conn); ev.Type != "workspace.joined" {
		t.Fatalf("first event = %s, want workspace.joined", ev.Type)
	}
	if ev := read(t, conn); ev.Type != "workspace.members_changed" {
		t.Fatalf("event = %s, want workspace.members_changed", ev.Type)
	}
	s.call(http.MethodPost, "/api/categories", admin, map[string]any{"workspace_id": ops, "name": "Ekip"}, nil)
	if ev := read(t, conn); ev.Type != "categories.changed" {
		t.Errorf("event = %s, want categories.changed", ev.Type)
	}
}

func TestJoiningByInvitationDeliversItsChannels(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	ops := s.newWorkspace(admin, "Operasyon")
	var dir struct{ Channels []channel }
	s.call(http.MethodGet, "/api/channels/directory?workspace_id="+ops, admin, nil, &dir)
	general := dir.Channels[0].ID

	conn := s.connect(ayse, "")
	read(t, conn) // hello
	s.call(http.MethodPost, "/api/invites/"+s.invite(admin, ops, map[string]any{})+"/accept", ayse, nil, nil)
	read(t, conn) // workspace.joined
	read(t, conn) // workspace.members_changed
	// Messages of the workspace's General reach the new member at once.
	s.send(admin, general, "hoş geldin", "welcome-nonce-1")
	if ev := read(t, conn); ev.Type != "message.created" {
		t.Fatalf("event = %s, want message.created", ev.Type)
	}
}
