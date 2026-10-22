// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/store"
)

func problemCode(t *testing.T, s *stack, method, path, token string, body any) (int, string) {
	t.Helper()
	var p struct {
		Code string `json:"code"`
	}
	res := s.call(method, path, token, body, &p)
	return res.StatusCode, p.Code
}

func TestDefaultChannels(t *testing.T) {
	sh := newShared(t)
	s := newStack(t, sh, options{})
	ayse := s.user("sub-a", "Ayşe")

	list := s.channels(ayse, "/api/channels")
	if len(list) != 2 || list[0].Name != "Central" || list[1].Name != "General" {
		t.Fatalf("channels = %+v", list)
	}
	central, general := list[0], list[1]
	if central.Kind != "announcement" || !central.IsMandatory || !central.IsDefault || central.CanPost {
		t.Errorf("Central = %+v", central)
	}
	if general.Kind != "standard" || general.IsMandatory || !general.IsDefault || !general.CanPost {
		t.Errorf("General = %+v", general)
	}

	// Running again (every start) changes nothing and keeps one channel per name,
	// whatever the case.
	q := store.New(sh.pool)
	if err := chat.EnsureDefaults(context.Background(), q, chat.Defaults{
		Announcement: "CENTRAL", Channels: []string{"General", "Random"}, AdminEmail: adminEmail,
	}); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, c := range s.channels(ayse, "/api/channels") {
		names = append(names, c.Name)
	}
	if len(names) != 3 || names[0] != "Central" || names[2] != "Random" {
		t.Errorf("after a second start: %v", names)
	}
}

func TestCentralIsReadOnlyAndMandatory(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	admin := s.admin()
	central := s.channelID(ayse, "Central")

	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+central+"/messages", ayse,
		map[string]string{"body": "hi", "nonce": "central-nonce-1"}); status != http.StatusForbidden || code != chat.CodeReadOnlyChannel {
		t.Errorf("member posting in Central = %d %s", status, code)
	}
	if _, res := s.send(admin, central, "Hoş geldiniz!", "central-nonce-2"); res.StatusCode != http.StatusCreated {
		t.Errorf("administrator posting in Central = %d", res.StatusCode)
	}
	var page struct {
		Messages []message `json:"messages"`
	}
	s.call(http.MethodGet, "/api/channels/"+central+"/messages", ayse, nil, &page)
	if len(page.Messages) != 1 {
		t.Errorf("members read Central: %+v", page)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+central+"/leave", ayse, nil); status != http.StatusForbidden || code != chat.CodeChannelMandatory {
		t.Errorf("leaving Central = %d %s", status, code)
	}
	// General can be left and joined again.
	general := s.general(ayse)
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/leave", ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("leaving General = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/join", ayse, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("joining General = %d", res.StatusCode)
	}
}

func TestOnlyTheAdministratorCreatesChannels(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	admin := s.admin()
	newChannel := map[string]any{"name": "  Release notes ", "topic": "What shipped"}

	if status, code := problemCode(t, s, http.MethodPost, "/api/channels", ayse, newChannel); status != http.StatusForbidden || code != "forbidden" {
		t.Fatalf("member creating a channel = %d %s", status, code)
	}
	var created channel
	if res := s.call(http.MethodPost, "/api/channels", admin, newChannel, &created); res.StatusCode != http.StatusCreated {
		t.Fatalf("administrator creating a channel = %d", res.StatusCode)
	}
	if created.Name != "Release notes" || !created.IsMember || created.IsDefault {
		t.Errorf("created = %+v", created)
	}
	for name, body := range map[string]map[string]any{
		"same name, other case": {"name": "release NOTES"},
		"same as Central":       {"name": "central"},
	} {
		if status, code := problemCode(t, s, http.MethodPost, "/api/channels", admin, body); status != http.StatusConflict || code != chat.CodeNameTaken {
			t.Errorf("%s: %d %s", name, status, code)
		}
	}
	for _, bad := range []map[string]any{{"name": "  "}, {"name": string(make([]byte, 81))}, {"name": "x", "kind": "secret"}} {
		if res := s.call(http.MethodPost, "/api/channels", admin, bad, nil); res.StatusCode != http.StatusBadRequest {
			t.Errorf("%v: %d", bad, res.StatusCode)
		}
	}

	// Others find it in the directory and must join before reading.
	var found channel
	for _, c := range s.channels(ayse, "/api/channels/directory") {
		if c.ID == created.ID {
			found = c
		}
	}
	if found.ID == "" || found.IsMember {
		t.Fatalf("directory entry = %+v", found)
	}
	if status, code := problemCode(t, s, http.MethodGet, "/api/channels/"+created.ID+"/messages", ayse, nil); status != http.StatusForbidden || code != chat.CodeNotAMember {
		t.Errorf("reading before joining = %d %s", status, code)
	}
	var joined channel
	s.call(http.MethodPost, "/api/channels/"+created.ID+"/join", ayse, nil, &joined)
	if !joined.IsMember || !joined.CanPost {
		t.Errorf("joined = %+v", joined)
	}
	if _, res := s.send(ayse, created.ID, "ilk not", "release-nonce-1"); res.StatusCode != http.StatusCreated {
		t.Errorf("posting after joining = %d", res.StatusCode)
	}

	// A default channel includes everyone at once.
	var everyone channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Kudos", "is_default": true}, &everyone)
	if s.channelID(ayse, "Kudos") != everyone.ID {
		t.Error("default channel without everyone")
	}
}

func TestEventsFollowMembership(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	admin := s.admin()
	var private channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Ops"}, &private)

	conn := s.connect(ayse, "")
	read(t, conn) // hello

	// Not a member: messages of Ops do not arrive; General's do.
	s.send(admin, private.ID, "gizli", "ops-nonce-1")
	s.send(admin, s.general(admin), "herkese", "gen-nonce-1")
	ev := read(t, conn)
	var m message
	_ = json.Unmarshal(ev.Data, &m)
	if ev.Type != "message.created" || m.Body != "herkese" {
		t.Fatalf("first event = %s %s", ev.Type, m.Body)
	}

	// Joining (from any connection) adds the channel to this connection.
	s.call(http.MethodPost, "/api/channels/"+private.ID+"/join", ayse, nil, nil)
	if ev := read(t, conn); ev.Type != "channel.joined" {
		t.Fatalf("event = %s, want channel.joined", ev.Type)
	}
	if ev := read(t, conn); ev.Type != "channel.members_changed" {
		t.Fatalf("event = %s, want channel.members_changed", ev.Type)
	}
	s.send(admin, private.ID, "artık görürsün", "ops-nonce-2")
	_ = json.Unmarshal(read(t, conn).Data, &m)
	if m.Body != "artık görürsün" {
		t.Errorf("after joining: %q", m.Body)
	}

	// A new default channel reaches everyone.
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Announcements 2", "is_default": true}, nil)
	if ev := read(t, conn); ev.Type != "channel.created" {
		t.Errorf("event = %s, want channel.created", ev.Type)
	}
}
