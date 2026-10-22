// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
)

func TestChannelTabs(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	path := "/api/channels/" + general + "/tabs"

	conn := s.connect(admin, "")
	read(t, conn)
	var link api.Tab
	if res := s.call(http.MethodPost, path, ayse, map[string]any{"kind": "link", "title": "Runbook", "url": "https://wiki.example.com/run"}, &link); res.StatusCode != http.StatusCreated {
		t.Fatalf("add link = %d", res.StatusCode)
	}
	if ev := read(t, conn); ev.Type != "tabs.changed" {
		t.Fatalf("event = %s, want tabs.changed", ev.Type)
	}
	if status, _ := problemCode(t, s, http.MethodPost, path, ayse, map[string]any{"kind": "link", "title": "X", "url": "javascript:alert(1)"}); status != http.StatusBadRequest {
		t.Errorf("javascript link = %d", status)
	}
	var canvas, list api.Tab
	s.call(http.MethodPost, path, ayse, map[string]any{"kind": "canvas", "title": "Notes"}, &canvas)
	s.call(http.MethodPost, path, admin, map[string]any{"kind": "list", "title": "Tasks"}, &list)
	if canvas.CanvasId == nil || list.ListId == nil || list.Position != 2 {
		t.Fatalf("canvas = %+v, list = %+v", canvas, list)
	}

	// Move the list first.
	var moved api.Tab
	s.call(http.MethodPatch, "/api/tabs/"+list.Id.String(), ayse, map[string]any{"position": 0}, &moved)
	var tabs struct{ Tabs []api.Tab }
	s.call(http.MethodGet, path, ayse, nil, &tabs)
	titles := []string{}
	for _, tab := range tabs.Tabs {
		titles = append(titles, tab.Title)
	}
	if strings.Join(titles, ",") != "Tasks,Runbook,Notes" {
		t.Errorf("tabs = %v", titles)
	}
	if tabs.Tabs[0].CanDelete || !tabs.Tabs[1].CanDelete {
		t.Errorf("Ayşe deletes the admin's tab = %v, her own = %v", tabs.Tabs[0].CanDelete, tabs.Tabs[1].CanDelete)
	}

	// Only who added a tab (and managers) delete it; its canvas goes with it.
	if status, _ := problemCode(t, s, http.MethodDelete, "/api/tabs/"+list.Id.String(), ayse, nil); status != http.StatusForbidden {
		t.Errorf("Ayşe deletes the admin's list = %d", status)
	}
	if res := s.call(http.MethodDelete, "/api/tabs/"+canvas.Id.String(), admin, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("admin deletes canvas tab = %d", res.StatusCode)
	}
	if n := s.count(`SELECT count(*) FROM canvases`); n != 0 {
		t.Errorf("canvases left = %d", n)
	}
	if res := s.call(http.MethodGet, "/api/canvases/"+canvas.CanvasId.String(), ayse, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("deleted canvas = %d", res.StatusCode)
	}

	// Outsiders see nothing; read-only channels take no tabs.
	var private channel
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "Gizli", "visibility": "private"}, &private)
	if res := s.call(http.MethodGet, "/api/channels/"+private.ID+"/tabs", ayse, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("tabs of a private channel = %d", res.StatusCode)
	}
	central := s.channelID(ayse, "Central")
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+central+"/tabs", ayse, map[string]any{"kind": "canvas", "title": "X"}); status != http.StatusForbidden {
		t.Errorf("tab in an announcement channel = %d", status)
	}
}

func TestCanvasTurnsAndVersions(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	var tab api.Tab
	s.call(http.MethodPost, "/api/channels/"+general+"/tabs", ayse, map[string]any{"kind": "canvas", "title": "Plan"}, &tab)
	path := "/api/canvases/" + tab.CanvasId.String()

	var cv api.Canvas
	if res := s.call(http.MethodPost, path+"/editing", ayse, nil, &cv); res.StatusCode != http.StatusOK || cv.EditingBy == nil || cv.EditingBy.DisplayName != "Ayşe" {
		t.Fatalf("take turn = %d, %+v", res.StatusCode, cv.EditingBy)
	}
	status, code := problemCode(t, s, http.MethodPost, path+"/editing", admin, nil)
	if status != http.StatusConflict || code != "canvas_busy" {
		t.Errorf("second editor = %d %s", status, code)
	}
	if status, code := problemCode(t, s, http.MethodPut, path, admin, map[string]any{"body": "x", "version": cv.Version}); status != http.StatusConflict || code != "canvas_busy" {
		t.Errorf("save during someone's turn = %d %s", status, code)
	}
	var saved api.Canvas
	if res := s.call(http.MethodPut, path, ayse, map[string]any{"body": "# Plan\n\n- ship", "version": cv.Version}, &saved); res.StatusCode != http.StatusOK {
		t.Fatalf("save = %d", res.StatusCode)
	}
	if saved.Version != cv.Version+1 || saved.EditingBy != nil || saved.UpdatedBy == nil || saved.Title != "Plan" {
		t.Errorf("saved = %+v", saved)
	}
	// Saving ends the turn; an old version is refused.
	if status, code := problemCode(t, s, http.MethodPut, path, admin, map[string]any{"body": "old", "version": cv.Version}); status != http.StatusConflict || code != "canvas_changed" {
		t.Errorf("stale save = %d %s", status, code)
	}
	if res := s.call(http.MethodPut, path, admin, map[string]any{"body": "new", "version": saved.Version}, &saved); res.StatusCode != http.StatusOK || saved.Body != "new" {
		t.Errorf("admin save = %d %q", res.StatusCode, saved.Body)
	}
	long := strings.Repeat("ş", 50001)
	if status, _ := problemCode(t, s, http.MethodPut, path, admin, map[string]any{"body": long, "version": saved.Version}); status != http.StatusBadRequest {
		t.Errorf("too long = %d", status)
	}
	// Giving back the turn lets others edit.
	s.call(http.MethodPost, path+"/editing", ayse, nil, nil)
	if res := s.call(http.MethodDelete, path+"/editing", ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("give back = %d", res.StatusCode)
	}
	if res := s.call(http.MethodPost, path+"/editing", admin, nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("admin takes turn = %d", res.StatusCode)
	}
}

func TestListsAndAssignedItems(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-ayse", "Ayşe")
	general := s.general(ayse)
	ayseID := s.userID(ayse)
	columns := []map[string]any{
		{"id": "status", "name": "Status", "kind": "status"},
		{"id": "owner", "name": "Owner", "kind": "person"},
		{"id": "due", "name": "Due", "kind": "date"},
		{"id": "size", "name": "Size", "kind": "select", "options": []string{"S", "M", "L"}},
	}
	var tab api.Tab
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/tabs", admin,
		map[string]any{"kind": "list", "title": "Launch", "columns": columns, "board_column": "status"}, &tab); res.StatusCode != http.StatusCreated {
		t.Fatalf("create list = %d", res.StatusCode)
	}
	bad := map[string]any{"kind": "list", "title": "X", "columns": columns, "board_column": "owner"}
	if status, _ := problemCode(t, s, http.MethodPost, "/api/channels/"+general+"/tabs", admin, bad); status != http.StatusBadRequest {
		t.Errorf("board by person = %d", status)
	}
	path := "/api/lists/" + tab.ListId.String()
	add := func(title string, values map[string]string) api.ListItem {
		t.Helper()
		var it api.ListItem
		if res := s.call(http.MethodPost, path+"/items", admin, map[string]any{"title": title, "values": values}, &it); res.StatusCode != http.StatusCreated {
			t.Fatalf("add %s = %d", title, res.StatusCode)
		}
		return it
	}
	a := add("Write notes", map[string]string{"status": "todo", "owner": ayseID, "due": "2026-11-02"})
	b := add("Book room", map[string]string{"status": "doing", "owner": ayseID, "due": "2026-10-30", "size": "M"})
	c := add("Order cake", map[string]string{"owner": s.userID(admin)})
	if status, _ := problemCode(t, s, http.MethodPost, path+"/items", admin, map[string]any{"title": "x", "values": map[string]string{"size": "XL"}}); status != http.StatusBadRequest {
		t.Errorf("unknown option = %d", status)
	}
	if status, _ := problemCode(t, s, http.MethodPost, path+"/items", admin, map[string]any{"title": "x", "values": map[string]string{"owner": "00000000-0000-7000-8000-000000000001"}}); status != http.StatusBadRequest {
		t.Errorf("stranger as owner = %d", status)
	}

	var mine struct{ Items []api.AssignedItem }
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/assigned-items", ayse, nil, &mine)
	if len(mine.Items) != 2 || mine.Items[0].Item.Id != b.Id || mine.Items[0].ListTitle != "Launch" || mine.Items[0].ChannelName != "General" {
		t.Fatalf("assigned = %+v", mine.Items)
	}
	// Done rows leave the list of assigned rows.
	var done api.ListItem
	s.call(http.MethodPatch, "/api/list-items/"+b.Id.String(), ayse, map[string]any{"values": map[string]string{"status": "done"}}, &done)
	if done.Values["size"] != "M" || done.Values["status"] != "done" {
		t.Errorf("values kept = %v", done.Values)
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/assigned-items", ayse, nil, &mine)
	if len(mine.Items) != 1 || mine.Items[0].Item.Id != a.Id {
		t.Errorf("assigned after done = %+v", mine.Items)
	}

	// Moving: c before a, then a to the end.
	order := func() string {
		var l api.ItemList
		s.call(http.MethodGet, path, ayse, nil, &l)
		titles := []string{}
		for _, it := range l.Items {
			titles = append(titles, it.Title)
		}
		return strings.Join(titles, ",")
	}
	s.call(http.MethodPatch, "/api/list-items/"+c.Id.String(), ayse, map[string]any{"before": a.Id}, nil)
	s.call(http.MethodPatch, "/api/list-items/"+a.Id.String(), ayse, map[string]any{"to_end": true}, nil)
	if got := order(); got != "Order cake,Book room,Write notes" {
		t.Errorf("order = %s", got)
	}
	for range 30 {
		s.call(http.MethodPatch, "/api/list-items/"+a.Id.String(), ayse, map[string]any{"before": b.Id}, nil)
		s.call(http.MethodPatch, "/api/list-items/"+b.Id.String(), ayse, map[string]any{"before": a.Id}, nil)
	}
	if got := order(); got != "Order cake,Book room,Write notes" {
		t.Errorf("order after many moves = %s", got)
	}

	// Removing a column drops its values; the board column must stay valid.
	var updated api.ItemList
	if res := s.call(http.MethodPut, path, admin, map[string]any{"columns": columns[1:], "board_column": "size"}, &updated); res.StatusCode != http.StatusOK {
		t.Fatalf("update columns = %d", res.StatusCode)
	}
	for _, it := range updated.Items {
		if _, ok := it.Values["status"]; ok {
			t.Errorf("%s keeps status", it.Title)
		}
	}
	s.call(http.MethodGet, "/api/workspaces/"+s.defaultWS+"/assigned-items", ayse, nil, &mine)
	if len(mine.Items) != 2 {
		t.Errorf("without a status column every row is open: %d", len(mine.Items))
	}
	if res := s.call(http.MethodDelete, "/api/list-items/"+c.Id.String(), ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Errorf("delete row = %d", res.StatusCode)
	}
}
