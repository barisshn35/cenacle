// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"image"
	"image/color/palette"
	"image/gif"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/groups"
)

func (s *stack) upload(method, path, token string, data []byte) (*http.Response, []byte) {
	s.t.Helper()
	req, _ := http.NewRequest(method, s.srv.URL+path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.client.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func (s *stack) me(token string) api.MyProfile {
	s.t.Helper()
	var me api.MyProfile
	if res := s.call(http.MethodGet, "/api/me/profile", token, nil, &me); res.StatusCode != http.StatusOK {
		s.t.Fatalf("me = %d", res.StatusCode)
	}
	return me
}

func (s *stack) profiles(token string, ids ...string) []api.Profile {
	s.t.Helper()
	var out struct {
		Profiles []api.Profile `json:"profiles"`
	}
	s.call(http.MethodGet, "/api/profiles?ids="+strings.Join(ids, ","), token, nil, &out)
	return out.Profiles
}

func animatedGIF(t *testing.T) []byte {
	t.Helper()
	g := &gif.GIF{}
	for i := range 3 {
		f := image.NewPaletted(image.Rect(0, 0, 40, 40), palette.Plan9)
		f.SetColorIndex(i, i, uint8(i+1))
		g.Image = append(g.Image, f)
		g.Delay = append(g.Delay, 10)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestProfiles(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.userWithEmail("sub-ayse", "Ayşe Yılmaz", "ayse.yilmaz@example.com")
	mert := s.user("sub-mert", "Mert")

	// A @username made from the address; changed, taken, reserved.
	me := s.me(ayse)
	if me.Username != "ayse.yilmaz" || !me.UsernameEditable || !me.ShowLastSeen || me.AccountUrl == "" {
		t.Fatalf("me = %+v", me)
	}
	mertID := s.userID(mert)
	s.me(mert)
	if status, code := problemCode(t, s, http.MethodPatch, "/api/me/profile", ayse, map[string]string{"username": "sub-mert"}); status != http.StatusConflict || code != "username_taken" {
		t.Errorf("taken username = %d %s", status, code)
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/me/profile", ayse, map[string]string{"username": "here"}); status != http.StatusBadRequest {
		t.Errorf("reserved username = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/me/profile", ayse, map[string]string{"timezone": "Mars/Olympus"}); status != http.StatusBadRequest {
		t.Errorf("unknown time zone = %d", status)
	}
	var changed api.MyProfile
	s.call(http.MethodPatch, "/api/me/profile", ayse, map[string]any{"username": "ayse", "timezone": "Europe/Istanbul", "show_last_seen": false}, &changed)
	if changed.Username != "ayse" || changed.Timezone != "Europe/Istanbul" || changed.ShowLastSeen {
		t.Errorf("changed = %+v", changed)
	}

	// Custom status: shown to others, the recent ones remembered, cleared.
	soon := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	s.call(http.MethodPut, "/api/me/status", ayse, map[string]any{"emoji": "🌴", "text": "On holiday", "expires_at": soon}, nil)
	s.call(http.MethodPut, "/api/me/status", ayse, map[string]any{"emoji": "🎧", "text": ""}, nil)
	me = s.me(ayse)
	if me.Status == nil || me.Status.Emoji != "🎧" || len(me.RecentStatuses) != 2 || me.RecentStatuses[1].Text != "On holiday" {
		t.Errorf("status = %+v, recent = %+v", me.Status, me.RecentStatuses)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/me/status", ayse, map[string]any{"emoji": "ab", "text": ""}); status != http.StatusBadRequest {
		t.Errorf("letters as emoji = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/me/status", ayse, map[string]any{"emoji": "", "text": "x", "expires_at": time.Now().Add(-time.Minute)}); status != http.StatusBadRequest {
		t.Errorf("status in the past = %d", status)
	}
	aysePublic := s.profiles(mert, s.userID(ayse))
	if len(aysePublic) != 1 || aysePublic[0].Status == nil || aysePublic[0].Username != "ayse" {
		t.Fatalf("seen by mert = %+v", aysePublic)
	}
	// An expired status reads as none (and the job clears it).
	s.call(http.MethodPut, "/api/me/status", mert, map[string]any{"emoji": "☕", "text": "Break", "expires_at": time.Now().Add(2 * time.Second)}, nil)
	time.Sleep(2500 * time.Millisecond)
	if p := s.profiles(ayse, mertID); len(p) != 1 || p[0].Status != nil {
		t.Errorf("expired status = %+v", p)
	}
	if n, err := s.bg.TidyProfiles(context.Background()); err != nil || n < 1 {
		t.Errorf("tidy = %d, %v", n, err)
	}
	if res := s.call(http.MethodDelete, "/api/me/status", ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("clear = %d", res.StatusCode)
	}

	// Pictures: a still one, an animated GIF with its first frame.
	res, body := s.upload(http.MethodPut, "/api/me/avatar", ayse, pngImage(t, 600, 400))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("avatar = %d %s", res.StatusCode, body)
	}
	me = s.me(ayse)
	if me.AvatarUrl == nil || me.AvatarStillUrl != nil {
		t.Fatalf("avatar urls = %v %v", me.AvatarUrl, me.AvatarStillUrl)
	}
	status, hdr, img := s.get(mert, *me.AvatarUrl)
	if status != http.StatusOK || hdr.Get("Content-Type") != "image/png" || !strings.Contains(hdr.Get("Cache-Control"), "immutable") {
		t.Errorf("picture = %d %v", status, hdr)
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(img)); err != nil || cfg.Width != 256 || cfg.Height != 256 {
		t.Errorf("picture size = %+v %v", cfg, err)
	}
	if status, _, _ := s.get("", *me.AvatarUrl); status != http.StatusUnauthorized {
		t.Errorf("picture without a session = %d", status)
	}
	old := *me.AvatarUrl
	s.upload(http.MethodPut, "/api/me/avatar", ayse, animatedGIF(t))
	me = s.me(ayse)
	if me.AvatarStillUrl == nil {
		t.Fatal("no still frame for the GIF")
	}
	if status, hdr, _ := s.get(mert, *me.AvatarUrl); status != http.StatusOK || hdr.Get("Content-Type") != "image/gif" {
		t.Errorf("gif = %d %s", status, hdr.Get("Content-Type"))
	}
	if status, hdr, _ := s.get(mert, *me.AvatarStillUrl); status != http.StatusOK || hdr.Get("Content-Type") != "image/png" {
		t.Errorf("still = %d %s", status, hdr.Get("Content-Type"))
	}
	if status, _, _ := s.get(mert, old); status != http.StatusNotFound {
		t.Errorf("replaced picture = %d", status)
	}
	if res, _ := s.upload(http.MethodPut, "/api/me/avatar", ayse, []byte("<svg/>")); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("svg avatar = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/me/avatar", ayse, nil, nil); res.StatusCode != http.StatusNoContent || s.me(ayse).AvatarUrl != nil {
		t.Errorf("delete avatar = %d", res.StatusCode)
	}

	// Strangers (no shared workspace or channel) are left out.
	if _, err := s.pool.Exec(context.Background(), "DELETE FROM workspace_members WHERE user_id = $1", mertID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(context.Background(), "DELETE FROM channel_members WHERE user_id = $1", mertID); err != nil {
		t.Fatal(err)
	}
	if p := s.profiles(ayse, mertID, s.userID(ayse)); len(p) != 1 {
		t.Errorf("stranger visible: %+v", p)
	}
}

func TestDirectoryUsernames(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	// Someone chose "bob"; the directory then gives "bob" to Bob.
	other := s.user("sub-other", "Other")
	s.me(other)
	s.call(http.MethodPatch, "/api/me/profile", other, map[string]string{"username": "bob"}, nil)
	bob := s.signInWith("sub-bob", "Bob", groups.Profile{Username: "bob"})
	me := s.me(bob)
	if me.Username != "bob" || me.UsernameEditable {
		t.Errorf("bob = %+v", me)
	}
	if status, code := problemCode(t, s, http.MethodPatch, "/api/me/profile", bob, map[string]string{"username": "robert"}); status != http.StatusForbidden || code != "username_managed" {
		t.Errorf("directory username change = %d %s", status, code)
	}
	if u := s.me(other).Username; u == "" || u == "bob" {
		t.Errorf("other got %q", u)
	}
}

func TestWorkspaceDetails(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	member := s.user("sub-m", "Member")
	ws := s.newWorkspace(admin, "Design")
	var out api.Workspace
	s.call(http.MethodPatch, "/api/workspaces/"+ws, admin, map[string]string{"description": "Everything design"}, &out)
	if out.Description != "Everything design" || out.Name != "Design" {
		t.Errorf("details = %+v", out)
	}
	res, body := s.upload(http.MethodPut, "/api/workspaces/"+ws+"/icon", admin, animatedGIF(t))
	if res.StatusCode != http.StatusOK || !strings.Contains(string(body), "/api/pictures/") {
		t.Fatalf("icon = %d %s", res.StatusCode, body)
	}
	if res, _ := s.upload(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/icon", member, pngImage(t, 10, 10)); res.StatusCode != http.StatusForbidden {
		t.Errorf("member sets icon = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/workspaces/"+ws+"/icon", admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete icon = %d", res.StatusCode)
	}
}
