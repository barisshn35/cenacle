// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bufio"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
)

func TestEditHistory(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	m, _ := s.send(ayse, general, "ilk hali", "eh-nonce-1")
	path := "/api/channels/" + general + "/messages/" + m.ID
	for _, body := range []string{"ikinci hali", "ikinci hali", "son hali"} {
		if res := s.call(http.MethodPatch, path, ayse, map[string]string{"body": body}, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("edit = %d", res.StatusCode)
		}
	}

	// The author sees the earlier versions, newest first (an unchanged save adds none).
	var got struct{ Edits []api.MessageEdit }
	if res := s.call(http.MethodGet, path+"/edits", ayse, nil, &got); res.StatusCode != http.StatusOK {
		t.Fatalf("edits = %d", res.StatusCode)
	}
	if len(got.Edits) != 2 || got.Edits[0].Body != "ikinci hali" || got.Edits[1].Body != "ilk hali" ||
		got.Edits[1].WrittenAt.After(got.Edits[1].ReplacedAt) {
		t.Errorf("edits = %+v", got.Edits)
	}
	// Others only when the workspace shows edit history to everyone.
	if status, _ := problemCode(t, s, http.MethodGet, path+"/edits", mert, nil); status != http.StatusForbidden {
		t.Errorf("other reads = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/workspaces/"+s.defaultWS, ayse, map[string]string{"edit_history": "everyone"}); status != http.StatusForbidden {
		t.Errorf("member changes the setting = %d", status)
	}
	var ws api.Workspace
	if res := s.call(http.MethodPatch, "/api/workspaces/"+s.defaultWS, admin, map[string]string{"edit_history": "everyone"}, &ws); res.StatusCode != http.StatusOK ||
		ws.EditHistory == nil || *ws.EditHistory != api.WorkspaceEditHistoryEveryone {
		t.Fatalf("setting = %d %+v", res.StatusCode, ws.EditHistory)
	}
	if res := s.call(http.MethodGet, path+"/edits", mert, nil, &got); res.StatusCode != http.StatusOK || len(got.Edits) != 2 {
		t.Errorf("other reads after = %d %d", res.StatusCode, len(got.Edits))
	}
	if status, _ := problemCode(t, s, http.MethodPatch, "/api/workspaces/"+s.defaultWS, admin, map[string]string{"edit_history": "nobody"}); status != http.StatusBadRequest {
		t.Errorf("unknown setting = %d", status)
	}

	// eDiscovery exports carry the earlier versions, oldest first.
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+"/api/workspaces/"+s.defaultWS+"/export?q=hali", nil)
	req.Header.Set("Authorization", "Bearer "+admin)
	res, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var line struct {
		Body  string `json:"body"`
		Edits []struct {
			Body string `json:"body"`
		} `json:"edits"`
	}
	sc := bufio.NewScanner(res.Body)
	if !sc.Scan() || json.Unmarshal(sc.Bytes(), &line) != nil {
		t.Fatalf("export = %d", res.StatusCode)
	}
	if line.Body != "son hali" || len(line.Edits) != 2 || line.Edits[0].Body != "ilk hali" {
		t.Errorf("exported = %+v", line)
	}

	// Deleted, its history is gone with it.
	s.call(http.MethodDelete, path, ayse, nil, nil)
	if status, _ := problemCode(t, s, http.MethodGet, path+"/edits", ayse, nil); status != http.StatusNotFound {
		t.Errorf("edits of a deleted message = %d", status)
	}
}
