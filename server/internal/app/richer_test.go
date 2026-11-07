// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// find returns a message of a timeline by id.
func find(t *testing.T, msgs []api.Message, id string) api.Message {
	t.Helper()
	for _, m := range msgs {
		if m.Id.String() == id {
			return m
		}
	}
	t.Fatalf("message %s not in the timeline", id)
	return api.Message{}
}

func TestLinkPreviews(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	s.general(mert)

	pic := pngImage(t, 800, 400)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/old":
			http.Redirect(w, r, "/page", http.StatusMovedPermanently)
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = fmt.Fprint(w, `<!doctype html><html><head><title>Fallback</title>
<meta property="og:title" content="Release   notes &amp; more">
<meta name="description" content="What changed">
<meta property="og:image" content="/cover.png"></head><body><meta property="og:title" content="ignored"></body></html>`)
		case "/cover.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pic)
		case "/plain":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = fmt.Fprint(w, "no page")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(site.Close)

	m, res := s.send(ayse, general, "see "+site.URL+"/old.", "nonce-link-1")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	plain, _ := s.send(ayse, general, "text "+site.URL+"/plain", "nonce-link-2")
	quiet, _ := s.send(ayse, general, "no preview <"+site.URL+"/page>", "nonce-link-3")
	if n, err := s.links.Run(context.Background()); err != nil || n != 2 {
		t.Fatalf("fetch = %d, %v", n, err)
	}
	if n, _ := s.links.Run(context.Background()); n != 0 {
		t.Errorf("second run = %d", n)
	}
	page := s.timeline(mert, general)
	lp := find(t, page, m.ID).LinkPreview
	if lp == nil || lp.Title != "Release notes & more" || lp.Description != "What changed" || lp.ImageUrl == nil || lp.Url != site.URL+"/old" {
		t.Fatalf("preview = %+v", lp)
	}
	if status, hdr, _ := s.get(mert, *lp.ImageUrl); status != http.StatusOK || hdr.Get("Content-Type") == "" {
		t.Errorf("preview image = %d", status)
	}
	if find(t, page, plain.ID).LinkPreview != nil || find(t, page, quiet.ID).LinkPreview != nil {
		t.Error("previews for a text file or a link in <>")
	}

	// The same link again uses the stored preview.
	again, _ := s.send(mert, general, site.URL+"/old", "nonce-link-4")
	_, _ = s.links.Run(context.Background())
	if find(t, s.timeline(ayse, general), again.ID).LinkPreview == nil {
		t.Error("stored preview not reused")
	}

	// Only the author removes it.
	path := "/api/channels/" + general + "/messages/" + m.ID + "/link-preview"
	if res := s.call(http.MethodDelete, path, mert, nil, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("other's removal = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, path, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("removal = %d", res.StatusCode)
	}
	if find(t, s.timeline(mert, general), m.ID).LinkPreview != nil {
		t.Error("removed preview still shown")
	}
}

func TestCustomEmojiAndStickers(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	s.general(mert)
	emojiPath := "/api/workspaces/" + s.defaultWS + "/emoji"

	res, _ := s.upload(http.MethodPost, emojiPath+"?name=party", ayse, pngImage(t, 64, 64))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("add emoji = %d", res.StatusCode)
	}
	if res, _ := s.upload(http.MethodPost, emojiPath+"?name=party", mert, pngImage(t, 64, 64)); res.StatusCode != http.StatusConflict {
		t.Errorf("same name = %d", res.StatusCode)
	}
	if res, _ := s.upload(http.MethodPost, emojiPath+"?name=Bad Name", mert, pngImage(t, 64, 64)); res.StatusCode != http.StatusBadRequest {
		t.Errorf("bad name = %d", res.StatusCode)
	}
	var list struct{ Emoji []api.CustomEmoji }
	s.call(http.MethodGet, emojiPath, mert, nil, &list)
	if len(list.Emoji) != 1 || list.Emoji[0].Name != "party" {
		t.Fatalf("emoji = %+v", list.Emoji)
	}

	// Reactions take the workspace's custom emoji.
	m, _ := s.send(ayse, general, "custom", "nonce-emoji-1")
	reactions := "/api/channels/" + general + "/messages/" + m.ID + "/reactions/"
	if res := s.call(http.MethodPut, reactions+":party:", mert, nil, nil); res.StatusCode/100 != 2 {
		t.Errorf("custom reaction = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPut, reactions+":nope:", mert, nil, nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown custom reaction = %d", res.StatusCode)
	}

	// Only its author or an admin deletes an emoji.
	if res := s.call(http.MethodDelete, "/api/emoji/"+list.Emoji[0].Id.String(), mert, nil, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("other's delete = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/emoji/"+list.Emoji[0].Id.String(), ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete = %d", res.StatusCode)
	}

	// Stickers.
	res, body := s.upload(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/stickers?name=Wave", ayse, pngImage(t, 300, 300))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("add sticker = %d %s", res.StatusCode, body)
	}
	var stickers struct{ Stickers []api.Sticker }
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/stickers", mert, nil, &stickers)
	if len(stickers.Stickers) != 1 {
		t.Fatalf("stickers = %+v", stickers)
	}
	sticker := stickers.Stickers[0]
	var sent api.Message
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", mert,
		map[string]any{"body": "", "nonce": "nonce-sticker-1", "sticker_id": sticker.Id}, &sent); res.StatusCode != http.StatusCreated {
		t.Fatalf("send sticker = %d", res.StatusCode)
	}
	got := find(t, s.timeline(ayse, general), sent.Id.String())
	if got.Sticker == nil || got.Sticker.Name != "Wave" || got.Sticker.Url == "" {
		t.Errorf("sticker = %+v", got.Sticker)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", mert,
		map[string]any{"body": "x", "nonce": "nonce-sticker-2", "sticker_id": "00000000-0000-7000-8000-000000000000"}); status != http.StatusBadRequest {
		t.Errorf("unknown sticker = %d", status)
	}
}

func TestForwardAndBroadcastMentions(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	s.general(mert)
	s.general(admin)

	// Forwarding copies the message, with where it came from.
	m, _ := s.send(ayse, general, "worth sharing", "nonce-fwd-1")
	dm, status := s.open(mert, s.defaultWS, s.userID(admin))
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("open = %d", status)
	}
	var fwd api.Message
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/forward", mert,
		map[string]any{"channel_id": dm.ID, "comment": "look"}, &fwd); res.StatusCode != http.StatusCreated {
		t.Fatalf("forward = %d", res.StatusCode)
	}
	if fwd.Body != "look" || fwd.Forward == nil || fwd.Forward.Body != "worth sharing" || fwd.Forward.Author.DisplayName != "Ayşe" ||
		fwd.Forward.ChannelName != "General" {
		t.Errorf("forwarded = %+v %+v", fwd, fwd.Forward)
	}
	// Not into a channel one is not in.
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages/"+m.ID+"/forward", ayse,
		map[string]any{"channel_id": dm.ID}, nil); res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Errorf("forward elsewhere = %d", res.StatusCode)
	}

	// Mentions of many reach people.
	count := func(id, kind string) int {
		var n int
		if err := s.pool.QueryRow(context.Background(),
			"SELECT count(*) FROM message_mentions WHERE message_id = $1 AND kind = $2", id, kind).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	all, _ := s.send(ayse, general, "@channel standup", "nonce-many-1")
	if n := count(all.ID, "channel"); n != 2 {
		t.Errorf("@channel reached %d", n)
	}
	var sent api.Message
	s.call(http.MethodGet, "/api/channels/"+general+"/messages/"+all.ID, ayse, nil, &sent)
	if sent.Broadcast == nil || len(*sent.Broadcast) != 1 || (*sent.Broadcast)[0] != "channel" {
		t.Errorf("broadcast = %v", sent.Broadcast)
	}
	// @all, and the Turkish words, mean the same.
	for i, body := range []string{"@all deploy", "@herkes toplantı", "@kanal duyuru"} {
		m, _ := s.send(ayse, general, body, fmt.Sprintf("nonce-many-all-%d", i))
		if n := count(m.ID, "channel"); n != 2 {
			t.Errorf("%q reached %d", body, n)
		}
	}
	admins, _ := s.send(mert, general, "help @admins", "nonce-many-2")
	if n := count(admins.ID, "role"); n != 1 {
		t.Errorf("@admins reached %d", n)
	}
	// @here reaches the people online: nobody is connected here.
	here, _ := s.send(mert, general, "@here anyone?", "nonce-many-3")
	if n := count(here.ID, "here"); n != 0 {
		t.Errorf("@here reached %d offline people", n)
	}
	conn := s.connect(ayse, "")
	defer func() { _ = conn.CloseNow() }()
	reached := false
	for i := range 50 {
		here, _ := s.send(mert, general, "@here now?", fmt.Sprintf("nonce-here-%d", i))
		if reached = count(here.ID, "here") == 1; reached {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !reached {
		t.Error("@here did not reach the online member")
	}
}

func TestBurnOnRead(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	general := s.general(ayse)
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))
	path := "/api/channels/" + dm.ID + "/messages"

	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/messages", ayse,
		map[string]any{"body": "secret", "nonce": "nonce-burn-0", "burn_seconds": 30}); status != http.StatusBadRequest {
		t.Errorf("burn in a channel = %d", status)
	}
	var m api.Message
	if res := s.call(http.MethodPost, path, ayse, map[string]any{"body": "the code is 1234", "nonce": "nonce-burn-1", "burn_seconds": 30}, &m); res.StatusCode != http.StatusCreated {
		t.Fatalf("send = %d", res.StatusCode)
	}
	// The recipient sees it hidden until revealing it; the author always sees it.
	if got := find(t, s.timeline(mert, dm.ID), m.Id.String()); got.Body != "" || got.Burn == nil || !got.Burn.Hidden {
		t.Errorf("before reveal = %q %+v", got.Body, got.Burn)
	}
	if got := find(t, s.timeline(ayse, dm.ID), m.Id.String()); got.Body != "the code is 1234" {
		t.Errorf("author's view = %q", got.Body)
	}
	var shown api.Message
	if res := s.call(http.MethodPost, path+"/"+m.Id.String()+"/reveal", mert, nil, &shown); res.StatusCode != http.StatusOK ||
		shown.Body != "the code is 1234" || shown.Burn == nil || shown.Burn.RevealedAt == nil {
		t.Fatalf("reveal = %d %+v", res.StatusCode, shown)
	}
	if status, code := problemCode(t, s, http.MethodPatch, path+"/"+m.Id.String(), ayse, map[string]any{"body": "x"}); status != http.StatusForbidden || code != "not_for_burn" {
		t.Errorf("edit = %d %s", status, code)
	}
	if status, _ := problemCode(t, s, http.MethodPut, path+"/"+m.Id.String()+"/pin", ayse, nil); status != http.StatusForbidden {
		t.Errorf("pin = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, path+"/"+m.Id.String()+"/forward", ayse, map[string]any{"channel_id": general}); status != http.StatusForbidden {
		t.Errorf("forward = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/me/saved/"+m.Id.String(), mert, map[string]any{}); status != http.StatusForbidden {
		t.Errorf("save = %d", status)
	}
	// No thread: it would show the text again in the threads list.
	if status, _ := problemCode(t, s, http.MethodPost, path, mert,
		map[string]any{"body": "ok", "nonce": "nonce-burn-2", "root_id": m.Id}); status != http.StatusBadRequest {
		t.Errorf("reply = %d", status)
	}
	if page := s.search(mert, "q=code"); len(page.Results) != 0 {
		t.Errorf("found by search: %+v", page.Results)
	}

	// Its time runs out: it burns, then is removed.
	if _, err := s.pool.Exec(context.Background(), "UPDATE burn_reveals SET revealed_at = now() - interval '1 minute'"); err != nil {
		t.Fatal(err)
	}
	if status, code := problemCode(t, s, http.MethodPost, path+"/"+m.Id.String()+"/reveal", mert, nil); status != http.StatusGone || code != "burned" {
		t.Errorf("after its time = %d %s", status, code)
	}
	if n, err := (chat.Purger{Queries: store.New(s.pool)}).PurgeBurned(context.Background()); err != nil || n != 1 {
		t.Errorf("purge = %d, %v", n, err)
	}
	for _, got := range s.timeline(ayse, dm.ID) {
		if got.Id == m.Id {
			t.Error("burned message still there")
		}
	}
}

func TestVoiceUploadFields(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	path := "/api/channels/" + general + "/files"
	var u struct {
		File api.FileInfo `json:"file"`
	}
	if res := s.call(http.MethodPost, path, ayse, map[string]any{"name": "voice.webm", "size": 100, "content_type": "audio/webm",
		"media_kind": "voice", "duration_ms": 4200, "waveform": []int{0, 40, 255, 12}}, &u); res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", res.StatusCode)
	}
	if u.File.MediaKind == nil || *u.File.MediaKind != "voice" || u.File.DurationMs == nil || *u.File.DurationMs != 4200 ||
		u.File.Waveform == nil || len(*u.File.Waveform) != 4 || (*u.File.Waveform)[2] != 255 {
		t.Errorf("file = %+v", u.File)
	}
	for _, bad := range []map[string]any{
		{"media_kind": "song"},
		{"media_kind": "clip", "waveform": []int{1}},
		{"media_kind": "voice", "waveform": []int{300}},
		{"duration_ms": 10},
	} {
		bad["name"], bad["size"] = "x.webm", 10
		if status, _ := problemCode(t, s, http.MethodPost, path, ayse, bad); status != http.StatusBadRequest {
			t.Errorf("%v = %d", bad, status)
		}
	}
}
