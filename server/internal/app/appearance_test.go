// SPDX-License-Identifier: Apache-2.0

package app_test

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
)

func TestAppearance(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")

	// Defaults until something is chosen.
	var a api.Appearance
	s.call(http.MethodGet, "/api/me/appearance", ayse, nil, &a)
	if a.Theme != "system" || a.Preset != "workspace" || a.Fonts.Text != "inter" || a.FontSize != 14 || a.Code.Theme != "github" {
		t.Fatalf("defaults = %+v", a)
	}
	a.Theme, a.Preset, a.Fonts.Template, a.Fonts.Text, a.FontSize = "dark", "ocean", "custom", "ibm-plex-sans", 16
	a.Code.LineNumbers = true
	if res := s.call(http.MethodPut, "/api/me/appearance", ayse, a, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("save = %d", res.StatusCode)
	}
	var back api.Appearance
	s.call(http.MethodGet, "/api/me/appearance", ayse, nil, &back)
	if back.Preset != "ocean" || back.FontSize != 16 || !back.Code.LineNumbers || back.Fonts.Text != "ibm-plex-sans" {
		t.Errorf("saved = %+v", back)
	}
	bad := back
	bad.FontSize = 40
	if status, _ := problemCode(t, s, http.MethodPut, "/api/me/appearance", ayse, bad); status != http.StatusBadRequest {
		t.Errorf("font size 40 = %d", status)
	}
	bad = back
	bad.Fonts.Code = "../../etc"
	if status, _ := problemCode(t, s, http.MethodPut, "/api/me/appearance", ayse, bad); status != http.StatusBadRequest {
		t.Errorf("odd font id = %d", status)
	}

	// Workspace defaults (owners and admins).
	admin := s.admin()
	ws := s.newWorkspace(admin, "Design")
	var out api.Workspace
	s.call(http.MethodPut, "/api/workspaces/"+ws+"/appearance", admin, map[string]string{"preset": "forest", "font_template": "reading"}, &out)
	if out.Appearance.Preset != "forest" || out.Appearance.FontTemplate != "reading" {
		t.Errorf("workspace appearance = %+v", out.Appearance)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/workspaces/"+s.defaultWS+"/appearance", ayse, map[string]string{"preset": "forest", "font_template": "reading"}); status != http.StatusForbidden {
		t.Errorf("member sets workspace appearance = %d", status)
	}
}

func TestUserFonts(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-ayse", "Ayşe")
	mert := s.user("sub-mert", "Mert")
	woff2 := append([]byte("wOF2"), bytes.Repeat([]byte{1}, 100)...)

	res, body := s.upload(http.MethodPost, "/api/me/fonts?name=My%20Font", ayse, woff2)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload = %d %s", res.StatusCode, body)
	}
	var fonts struct {
		Fonts []api.UserFont `json:"fonts"`
	}
	s.call(http.MethodGet, "/api/me/fonts", ayse, nil, &fonts)
	if len(fonts.Fonts) != 1 || fonts.Fonts[0].Format != "woff2" || fonts.Fonts[0].Name != "My Font" {
		t.Fatalf("fonts = %+v", fonts)
	}
	id := fonts.Fonts[0].Id.String()
	if status, hdr, data := s.get(ayse, "/api/fonts/"+id); status != http.StatusOK || hdr.Get("Content-Type") != "font/woff2" || !bytes.Equal(data, woff2) {
		t.Errorf("get own font = %d %s", status, hdr.Get("Content-Type"))
	}
	if status, _, _ := s.get(mert, "/api/fonts/"+id); status != http.StatusNotFound {
		t.Errorf("someone else's font = %d", status)
	}
	if res, _ := s.upload(http.MethodPost, "/api/me/fonts?name=x", ayse, []byte("<svg/>")); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("not a font = %d", res.StatusCode)
	}
	for range 4 {
		s.upload(http.MethodPost, "/api/me/fonts?name=more", ayse, woff2)
	}
	if res, _ := s.upload(http.MethodPost, "/api/me/fonts?name=sixth", ayse, woff2); res.StatusCode != http.StatusConflict {
		t.Errorf("sixth font = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/me/fonts/"+id, mert, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("delete someone else's = %d", res.StatusCode)
	}
	if res := s.call(http.MethodDelete, "/api/me/fonts/"+id, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete = %d", res.StatusCode)
	}
}

func TestUITexts(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	member := s.user("sub-m", "Member")
	var out api.UITexts
	// Readable without a session (the sign-in page uses it).
	if res := s.call(http.MethodGet, "/api/ui-texts", "", nil, &out); res.StatusCode != http.StatusOK || len(out.Editable) == 0 {
		t.Fatalf("texts = %d %+v", res.StatusCode, out)
	}
	body := map[string]any{"locale": "tr", "texts": map[string]string{"auth.title": "Acme sohbetine giriş yap", "auth.help": ""}}
	if res := s.call(http.MethodPut, "/api/ui-texts", admin, body, &out); res.StatusCode != http.StatusOK {
		t.Fatalf("set = %d", res.StatusCode)
	}
	if out.Texts["tr"]["auth.title"] != "Acme sohbetine giriş yap" || out.Texts["tr"]["auth.help"] != "" {
		t.Errorf("texts = %+v", out.Texts)
	}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/ui-texts", member, body); status != http.StatusForbidden {
		t.Errorf("member = %d", status)
	}
	bad := map[string]any{"locale": "tr", "texts": map[string]string{"chat.send": "x"}}
	if status, _ := problemCode(t, s, http.MethodPut, "/api/ui-texts", admin, bad); status != http.StatusBadRequest {
		t.Errorf("not editable = %d", status)
	}
}
