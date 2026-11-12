// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
)

func TestOutOfOffice(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	zeynep := s.user("sub-z", "Zeynep")
	ayseID, mertID := s.userID(ayse), s.userID(mert)
	now := time.Now().UTC().Truncate(time.Second)
	until := now.Add(72 * time.Hour)

	var me api.MyProfile
	res := s.call(http.MethodPut, "/api/me/out-of-office", ayse, map[string]any{
		"from": now.Add(-time.Hour), "until": until, "message": "  Back on Monday; ask Zeynep meanwhile. ",
	}, &me)
	if res.StatusCode != http.StatusOK || me.OutOfOffice == nil || me.OutOfOffice.Message != "Back on Monday; ask Zeynep meanwhile." {
		t.Fatalf("set = %d %+v", res.StatusCode, me.OutOfOffice)
	}
	// Others see it on the profile.
	var profiles struct{ Profiles []api.Profile }
	s.call(http.MethodGet, "/api/profiles?ids="+ayseID, mert, nil, &profiles)
	if len(profiles.Profiles) != 1 || profiles.Profiles[0].OutOfOffice == nil || !profiles.Profiles[0].OutOfOffice.Until.Equal(until) {
		t.Errorf("profile = %+v", profiles.Profiles)
	}

	// A direct message gets one automatic reply per conversation.
	dm, _ := s.open(mert, s.defaultWS, ayseID)
	s.send(mert, dm.ID, "Are you around?", "ooo-test-1")
	s.send(mert, dm.ID, "Hello?", "ooo-test-2")
	var page api.MessagePage
	s.call(http.MethodGet, "/api/channels/"+dm.ID+"/messages", mert, nil, &page)
	replies := 0
	for _, m := range page.Messages {
		if len(m.Attachments) > 0 && m.Attachments[0].AutoReply != nil {
			replies++
			if m.Author.Id.String() != ayseID || m.Body != "Back on Monday; ask Zeynep meanwhile." ||
				!m.Attachments[0].AutoReply.Until.Equal(until) {
				t.Errorf("automatic reply = %+v", m)
			}
		}
	}
	if replies != 1 || len(page.Messages) != 3 {
		t.Errorf("messages = %d, automatic replies = %d", len(page.Messages), replies)
	}
	// Ayşe writing herself does not answer herself; group conversations get none.
	s.send(ayse, dm.ID, "Quickly: yes.", "ooo-test-3")
	group, _ := s.open(zeynep, s.defaultWS, ayseID, mertID)
	s.send(zeynep, group.ID, "Team?", "ooo-test-4")
	page = api.MessagePage{}
	s.call(http.MethodGet, "/api/channels/"+group.ID+"/messages", zeynep, nil, &page)
	if len(page.Messages) != 1 {
		t.Errorf("group messages = %d", len(page.Messages))
	}

	// A new absence answers again; being back ends it.
	s.call(http.MethodPut, "/api/me/out-of-office", ayse, map[string]any{"from": now.Add(-time.Minute), "until": until, "message": ""}, nil)
	s.send(mert, dm.ID, "Still away?", "ooo-test-5")
	page = api.MessagePage{}
	s.call(http.MethodGet, "/api/channels/"+dm.ID+"/messages", mert, nil, &page)
	if last := page.Messages[len(page.Messages)-1]; len(last.Attachments) == 0 || last.Attachments[0].AutoReply == nil || last.Body != "" {
		t.Errorf("second absence: newest = %+v", last)
	}
	if res := s.call(http.MethodDelete, "/api/me/out-of-office", ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("clear = %d", res.StatusCode)
	}
	profiles.Profiles = nil
	s.call(http.MethodGet, "/api/profiles?ids="+ayseID, mert, nil, &profiles)
	if profiles.Profiles[0].OutOfOffice != nil {
		t.Errorf("after clearing: %+v", profiles.Profiles[0].OutOfOffice)
	}

	// Validation.
	for _, in := range []map[string]any{
		{"from": now, "until": now.Add(-time.Hour), "message": ""},
		{"from": now.Add(-48 * time.Hour), "until": now.Add(-time.Hour), "message": ""},
		{"from": now, "until": now.Add(400 * 24 * time.Hour), "message": ""},
	} {
		if status, _ := problemCode(t, s, http.MethodPut, "/api/me/out-of-office", ayse, in); status != http.StatusBadRequest {
			t.Errorf("%v = %d", in, status)
		}
	}
}
