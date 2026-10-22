// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/chat"
)

func TestEditAndDeleteMessages(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	admin := s.admin()
	general := s.general(ayse)
	base := "/api/channels/" + general + "/messages/"

	m, _ := s.send(ayse, general, "ilk hali", "edit-nonce-1")

	// Only the author edits.
	if status, _ := problemCode(t, s, http.MethodPatch, base+m.ID, mert, map[string]string{"body": "değil"}); status != http.StatusForbidden {
		t.Errorf("someone else editing = %d", status)
	}
	var edited struct {
		Body     string  `json:"body"`
		EditedAt *string `json:"edited_at"`
	}
	if res := s.call(http.MethodPatch, base+m.ID, ayse, map[string]string{"body": "  son hali "}, &edited); res.StatusCode != http.StatusOK ||
		edited.Body != "son hali" || edited.EditedAt == nil {
		t.Fatalf("edit = %d %+v", res.StatusCode, edited)
	}

	// Others cannot delete; the author and a channel manager can.
	if status, _ := problemCode(t, s, http.MethodDelete, base+m.ID, mert, nil); status != http.StatusForbidden {
		t.Errorf("someone else deleting = %d", status)
	}
	if res := s.call(http.MethodDelete, base+m.ID, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	var page struct {
		Messages []message `json:"messages"`
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/messages", ayse, nil, &page)
	if len(page.Messages) != 0 {
		t.Errorf("deleted message still listed: %+v", page.Messages)
	}
	if status, _ := problemCode(t, s, http.MethodPatch, base+m.ID, ayse, map[string]string{"body": "x"}); status != http.StatusNotFound {
		t.Errorf("editing a deleted message = %d", status)
	}

	// Undo brings it back.
	if res := s.call(http.MethodPost, base+m.ID+"/restore", ayse, nil, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("restore = %d", res.StatusCode)
	}
	s.call(http.MethodGet, "/api/channels/"+general+"/messages", ayse, nil, &page)
	if len(page.Messages) != 1 || page.Messages[0].Body != "son hali" {
		t.Errorf("after restore: %+v", page.Messages)
	}

	// The administrator manages every channel: moderation.
	if res := s.call(http.MethodDelete, base+m.ID, admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("administrator deleting = %d", res.StatusCode)
	}

	// After the restore window it is gone for good.
	if _, err := s.pool.Exec(context.Background(), "UPDATE messages SET deleted_at = now() - interval '6 minutes'"); err != nil {
		t.Fatal(err)
	}
	if status, _ := problemCode(t, s, http.MethodPost, base+m.ID+"/restore", ayse, nil); status != http.StatusNotFound {
		t.Errorf("restore after the window = %d", status)
	}
	var left int
	_ = s.pool.QueryRow(context.Background(), "DELETE FROM messages WHERE deleted_at <= now() - interval '5 minutes' RETURNING 1").Scan(&left)
	if left != 1 {
		t.Errorf("purge removed %d", left)
	}
}

func TestMessageEventsForEditAndDelete(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	conn := s.connect(mert, "")
	read(t, conn)

	m, _ := s.send(ayse, general, "yazım hatası", "ev-nonce-1")
	read(t, conn) // created
	s.call(http.MethodPatch, "/api/channels/"+general+"/messages/"+m.ID, ayse, map[string]string{"body": "düzeltildi"}, nil)
	ev := read(t, conn)
	var got message
	_ = json.Unmarshal(ev.Data, &got)
	if ev.Type != "message.updated" || got.Body != "düzeltildi" {
		t.Errorf("event = %s %q", ev.Type, got.Body)
	}
	s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+m.ID, ayse, nil, nil)
	ev = read(t, conn)
	var ref struct {
		ID        string `json:"id"`
		ChannelID string `json:"channel_id"`
	}
	_ = json.Unmarshal(ev.Data, &ref)
	if ev.Type != "message.deleted" || ref.ID != m.ID || ref.ChannelID != general {
		t.Errorf("event = %s %+v", ev.Type, ref)
	}
}

func TestArchiveRenameAndCategories(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	var c channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Eski proje", "is_default": true}, &c)

	// Rename (unique), but not the channels of the installation settings.
	var renamed channel
	if res := s.call(http.MethodPatch, "/api/channels/"+c.ID, admin, map[string]string{"name": "Arşiv adayı"}, &renamed); res.StatusCode != http.StatusOK || renamed.Name != "Arşiv adayı" {
		t.Errorf("rename = %d %+v", res.StatusCode, renamed)
	}
	if status, code := problemCode(t, s, http.MethodPatch, "/api/channels/"+c.ID, admin, map[string]string{"name": "general"}); status != http.StatusConflict || code != chat.CodeNameTaken {
		t.Errorf("rename to a taken name = %d %s", status, code)
	}
	general := s.general(admin)
	if status, code := problemCode(t, s, http.MethodPatch, "/api/channels/"+general, admin, map[string]string{"name": "Genel"}); status != http.StatusForbidden || code != chat.CodeConfiguredName {
		t.Errorf("renaming General = %d %s", status, code)
	}

	// Archive: read-only, gone from the sidebar, in the directory, restorable.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+c.ID+"/archive", ayse, nil); status != http.StatusForbidden {
		t.Errorf("member archiving = %d", status)
	}
	var archived channel
	s.call(http.MethodPost, "/api/channels/"+c.ID+"/archive", admin, nil, &archived)
	for _, x := range s.channels(ayse, "/api/channels") {
		if x.ID == c.ID {
			t.Error("archived channel in the sidebar")
		}
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+c.ID+"/messages", ayse,
		map[string]string{"body": "x", "nonce": "arch-nonce-1"}); status != http.StatusForbidden || code != chat.CodeChannelArchived {
		t.Errorf("posting in an archived channel = %d %s", status, code)
	}
	if status, code := problemCode(t, s, http.MethodPost, "/api/channels/"+s.channelID(admin, "Central")+"/archive", admin, nil); status != http.StatusForbidden || code != chat.CodeChannelMandatory {
		t.Errorf("archiving Central = %d %s", status, code)
	}
	s.call(http.MethodPost, "/api/channels/"+c.ID+"/unarchive", admin, nil, nil)
	if s.channelID(ayse, "Arşiv adayı") != c.ID {
		t.Error("unarchived channel not back in the sidebar")
	}

	// Categories: the administrator creates, orders and assigns them.
	if status, _ := problemCode(t, s, http.MethodPost, "/api/categories", ayse, map[string]string{"name": "X"}); status != http.StatusForbidden {
		t.Errorf("member creating a category = %d", status)
	}
	var eng, info struct {
		ID       string `json:"id"`
		Position int    `json:"position"`
	}
	s.call(http.MethodPost, "/api/categories", admin, map[string]string{"name": "Mühendislik"}, &eng)
	s.call(http.MethodPost, "/api/categories", admin, map[string]string{"name": "Bilgi"}, &info)
	if info.Position != eng.Position+1 {
		t.Errorf("positions %d, %d", eng.Position, info.Position)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/categories", admin, map[string]string{"name": "mühendislik"}); status != http.StatusConflict {
		t.Errorf("duplicate category = %d", status)
	}
	s.call(http.MethodPatch, "/api/categories/"+info.ID, admin, map[string]int{"position": -1}, nil)
	var cats struct {
		Categories []struct {
			Name string `json:"name"`
		} `json:"categories"`
	}
	s.call(http.MethodGet, "/api/categories", ayse, nil, &cats)
	if len(cats.Categories) != 2 || cats.Categories[0].Name != "Bilgi" {
		t.Errorf("categories = %+v", cats.Categories)
	}
	var placed struct {
		CategoryID *string `json:"category_id"`
	}
	s.call(http.MethodPut, "/api/channels/"+c.ID+"/category", admin, map[string]string{"category_id": eng.ID}, &placed)
	if placed.CategoryID == nil || *placed.CategoryID != eng.ID {
		t.Errorf("placed = %+v", placed)
	}
	// Deleting a category keeps its channels, without category.
	s.call(http.MethodDelete, "/api/categories/"+eng.ID, admin, nil, nil)
	for _, x := range s.channels(ayse, "/api/channels") {
		if x.ID == c.ID && x.Name != "Arşiv adayı" {
			t.Error("channel lost with its category")
		}
	}
	var after struct {
		Channels []struct {
			ID         string  `json:"id"`
			CategoryID *string `json:"category_id"`
		} `json:"channels"`
	}
	s.call(http.MethodGet, "/api/channels", ayse, nil, &after)
	for _, x := range after.Channels {
		if x.ID == c.ID && x.CategoryID != nil {
			t.Error("channel still in the deleted category")
		}
	}
}
