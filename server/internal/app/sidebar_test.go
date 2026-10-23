// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"net/http"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/api"
)

func TestSidebar(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	path := "/api/workspaces/" + s.defaultWS + "/sidebar"

	var got api.SidebarLayout
	if res := s.call(http.MethodGet, path, ayse, nil, &got); res.StatusCode != http.StatusOK ||
		len(got.Sections) != 0 || len(got.Placements) != 0 || got.Order == nil {
		t.Fatalf("empty sidebar = %d %+v", res.StatusCode, got)
	}

	general := s.general(ayse)
	dm, _ := s.open(ayse, s.defaultWS, s.userID(mert))
	theirs, _ := s.open(mert, s.defaultWS, s.userID(s.user("sub-z", "Zeynep")))
	section := "0199a7a0-0000-7000-8000-000000000001"
	conn := s.connect(ayse, "")
	read(t, conn) // hello
	in := map[string]any{
		"order":    []string{"direct", section, "favorites", "nonsense", "direct"},
		"sections": []map[string]string{{"id": section, "name": "  Ekip   işleri "}},
		"placements": map[string]string{
			general:    "favorites",
			dm.ID:      section,
			theirs.ID:  "favorites", // not hers
			"not-a-id": "favorites",
		},
		"group_unreads": true,
		"collapsed":     []string{section, "elsewhere"},
	}
	if res := s.call(http.MethodPut, path, ayse, in, &got); res.StatusCode != http.StatusOK {
		t.Fatalf("set sidebar = %d", res.StatusCode)
	}
	if len(got.Sections) != 1 || got.Sections[0].Name != "Ekip işleri" || len(got.Placements) != 2 ||
		got.Placements[general] != "favorites" || got.Placements[dm.ID] != section ||
		len(got.Order) != 3 || got.Order[0] != "direct" || len(got.Collapsed) != 1 || !got.GroupUnreads {
		t.Errorf("kept = %+v", got)
	}
	if ev := read(t, conn); ev.Type != "sidebar.changed" {
		t.Errorf("event = %+v", ev)
	}
	var again api.SidebarLayout
	s.call(http.MethodGet, path, ayse, nil, &again)
	if len(again.Placements) != 2 || again.Sections[0].Name != "Ekip işleri" {
		t.Errorf("read back = %+v", again)
	}
	// Each person has their own.
	var his api.SidebarLayout
	s.call(http.MethodGet, path, mert, nil, &his)
	if len(his.Placements) != 0 {
		t.Errorf("mert sees = %+v", his)
	}

	// Placing into a section that is gone drops the placement.
	in["sections"] = []map[string]string{}
	var after api.SidebarLayout
	s.call(http.MethodPut, path, ayse, in, &after)
	if len(after.Placements) != 1 || after.Placements[general] != "favorites" {
		t.Errorf("after removing the section = %+v", after.Placements)
	}

	bad := func(name string, sections []map[string]string) {
		t.Helper()
		in["sections"] = sections
		if status, _ := problemCode(t, s, http.MethodPut, path, ayse, in); status != http.StatusBadRequest {
			t.Errorf("%s = %d", name, status)
		}
	}
	bad("empty name", []map[string]string{{"id": section, "name": "  "}})
	bad("same names", []map[string]string{{"id": section, "name": "A"}, {"id": "0199a7a0-0000-7000-8000-000000000002", "name": "a"}})
	bad("same ids", []map[string]string{{"id": section, "name": "A"}, {"id": section, "name": "B"}})
	if status, _ := problemCode(t, s, http.MethodGet, "/api/workspaces/0199a7a0-0000-7000-8000-00000000ffff/sidebar", ayse, nil); status != http.StatusNotFound {
		t.Errorf("unknown workspace = %d", status)
	}
}
