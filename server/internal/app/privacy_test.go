// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func (s *stack) download(token, path string) (int, []map[string]any) {
	s.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.client.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	var lines []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			lines = append(lines, m)
		}
	}
	return res.StatusCode, lines
}

func kinds(lines []map[string]any) map[string]int {
	out := map[string]int{}
	for _, l := range lines {
		out[l["kind"].(string)]++
	}
	return out
}

func TestDataSubjectRequests(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe Yılmaz")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	var ch struct{ ID string }
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"workspace_id": s.defaultWS, "name": "hukuk"}, &ch)
	s.call(http.MethodPost, "/api/channels/"+ch.ID+"/members", admin, map[string]any{"user_id": s.userID(ayse)}, nil)
	s.send(ayse, general, "merhaba", "dsr-nonce-1")
	s.send(ayse, ch.ID, "sözleşme", "dsr-nonce-2")
	m, _ := s.send(mert, general, "selam", "dsr-nonce-3")
	s.call(http.MethodPut, "/api/channels/"+general+"/messages/"+m.ID+"/reactions/%F0%9F%91%8D", ayse, nil, nil)

	// The person's own copy, and the administrator's for a request.
	status, mine := s.download(ayse, "/api/me/export")
	k := kinds(mine)
	if status != http.StatusOK || k["profile"] != 1 || k["message"] != 2 || k["reaction"] != 1 || k["channel"] < 2 || k["session"] < 1 {
		t.Fatalf("my export = %d %v", status, k)
	}
	if status, _ := problemCode(t, s, http.MethodGet, "/api/admin/users/"+s.userID(ayse)+"/export", mert, nil); status != http.StatusForbidden {
		t.Errorf("member exports someone = %d", status)
	}
	if status, lines := s.download(admin, "/api/admin/users/"+s.userID(ayse)+"/export"); status != http.StatusOK || kinds(lines)["message"] != 2 {
		t.Errorf("admin export = %d %v", status, kinds(lines))
	}

	// Erasure keeps what a legal hold keeps.
	if res := s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/legal-holds", admin, map[string]any{
		"name": "Dava 7", "user_ids": []string{}, "channel_ids": []string{ch.ID},
	}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("hold = %d", res.StatusCode)
	}
	ayseID := s.userID(ayse)
	erase := "/api/admin/users/" + ayseID + "/erase"
	if status, _ := problemCode(t, s, http.MethodPost, erase, admin, map[string]string{"confirm": "Ayşe"}); status != http.StatusBadRequest {
		t.Errorf("wrong confirmation = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/admin/users/"+s.userID(admin)+"/erase", admin, map[string]string{"confirm": "Yönetici"}); status != http.StatusForbidden {
		t.Errorf("erase yourself = %d", status)
	}
	var counts struct {
		Erased int `json:"messages_erased"`
		Held   int `json:"messages_held"`
	}
	if res := s.call(http.MethodPost, erase, admin, map[string]string{"confirm": "Ayşe Yılmaz"}, &counts); res.StatusCode != http.StatusOK || counts.Erased != 1 || counts.Held != 1 {
		t.Fatalf("erase = %d %+v", res.StatusCode, counts)
	}
	if res := s.call(http.MethodGet, "/api/channels", ayse, nil, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("erased person's session = %d", res.StatusCode)
	}
	var name, email, service string
	var reactions int
	ctx := context.Background()
	_ = s.pool.QueryRow(ctx, `SELECT display_name, email, auth_service FROM users WHERE id = $1`, ayseID).Scan(&name, &email, &service)
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM message_reactions WHERE user_id = $1`, ayseID).Scan(&reactions)
	if name != "Deleted user" || email != "" || service != "erased" || reactions != 0 {
		t.Errorf("after erasure: %q %q %q, %d reactions", name, email, service, reactions)
	}
	if status, _ := problemCode(t, s, http.MethodPost, erase, admin, map[string]string{"confirm": "Deleted user"}); status != http.StatusConflict {
		t.Errorf("erase twice = %d", status)
	}
	for _, m := range s.page(mert, general) {
		if m.Body == "merhaba" {
			t.Error("the erased message still shows")
		}
	}
}
