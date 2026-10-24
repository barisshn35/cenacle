// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
)

// joinGuest joins with a guest link and returns the session token the cookie carries.
func (s *stack) joinGuest(token, name, password string) (int, string, string) {
	s.t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name, "password": password})
	res, err := s.client.Post(s.srv.URL+"/api/guest-links/"+token, "application/json", bytes.NewReader(body))
	if err != nil {
		s.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out struct {
		Code      string `json:"code"`
		ChannelID string `json:"channel_id"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	session := ""
	for _, c := range res.Cookies() {
		if c.Value != "" {
			session = c.Value
		}
	}
	if out.Code != "" {
		return res.StatusCode, out.Code, ""
	}
	return res.StatusCode, out.ChannelID, session
}

func TestGuestLinks(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	links := "/api/channels/" + general + "/guest-links"
	link := map[string]any{"name": "Müşteri", "expires_in_hours": 24, "password": "dogru-parola", "max_uses": 2}

	if status, _ := problemCode(t, s, http.MethodPost, links, ayse, link); status != http.StatusForbidden {
		t.Errorf("member creates a guest link = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, links, admin, map[string]any{"expires_in_hours": 24, "password": "short"}); status != http.StatusBadRequest {
		t.Errorf("short password = %d", status)
	}
	var created struct {
		Link  api.GuestLink
		Token string
	}
	if res := s.call(http.MethodPost, links, admin, link, &created); res.StatusCode != http.StatusCreated || created.Token == "" {
		t.Fatalf("create = %d", res.StatusCode)
	}

	// Anyone with the link sees where it leads; the password lets them in.
	var preview api.GuestLinkPreview
	if res := s.call(http.MethodGet, "/api/guest-links/"+created.Token, "", nil, &preview); res.StatusCode != http.StatusOK || !preview.Valid || preview.ChannelName != "General" {
		t.Fatalf("preview = %d %+v", res.StatusCode, preview)
	}
	if status, code, _ := s.joinGuest(created.Token, "Ziyaretçi", "yanlis-parola"); status != http.StatusForbidden || code != "wrong_password" {
		t.Errorf("wrong password = %d %s", status, code)
	}
	status, channel, guest := s.joinGuest(created.Token, "Ziyaretçi", "dogru-parola")
	if status != http.StatusCreated || channel != general || guest == "" {
		t.Fatalf("join = %d %s", status, channel)
	}
	// A guest of that one channel: it writes there and sees nothing else.
	if _, res := s.send(guest, general, "merhaba", "guest-nonce-1"); res.StatusCode != http.StatusCreated {
		t.Errorf("guest posts = %d", res.StatusCode)
	}
	if cs := s.channels(guest, "/api/channels"); len(cs) != 1 || cs[0].ID != general {
		t.Errorf("guest's channels = %+v", cs)
	}
	var listed struct{ Links []api.GuestLink }
	s.call(http.MethodGet, links, admin, nil, &listed)
	if len(listed.Links) != 1 || listed.Links[0].Guests != 1 || listed.Links[0].Uses != 1 {
		t.Errorf("links = %+v", listed.Links)
	}

	// Used up after two people; revoking ends the guests' sessions.
	if status, _, _ := s.joinGuest(created.Token, "İkinci", "dogru-parola"); status != http.StatusCreated {
		t.Errorf("second join = %d", status)
	}
	if status, code, _ := s.joinGuest(created.Token, "Üçüncü", "dogru-parola"); status != http.StatusGone || code != "guest_link_invalid" {
		t.Errorf("used up = %d %s", status, code)
	}
	if res := s.call(http.MethodDelete, links+"/"+created.Link.Id.String(), admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke = %d", res.StatusCode)
	}
	if res := s.call(http.MethodGet, "/api/channels", guest, nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("guest after revoke = %d", res.StatusCode)
	}
	var n int
	if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE guest_link_id IS NOT NULL AND deactivated_at IS NULL`).Scan(&n); err != nil || n != 0 {
		t.Errorf("active link guests = %d %v", n, err)
	}
}
