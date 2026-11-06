// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func TestContentSearch(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)

	// A file whose name says nothing; its text is found once it was read.
	doc := s.uploadFile(ayse, general, "notlar.txt", "text/plain", []byte("Bütçe toplantısı perşembe günü yapılacak.\nGündem: zeytinyağı fiyatları."))
	if res := s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse, map[string]any{
		"body": "", "nonce": "cs-nonce-1", "file_ids": []string{doc.ID},
	}, nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("send file = %d", res.StatusCode)
	}
	reader := &chat.FileTextReader{Queries: store.New(s.pool), Files: s.bg.Files}
	if n, err := reader.Run(context.Background()); err != nil || n != 1 {
		t.Fatalf("read texts = %d %v", n, err)
	}
	var files struct{ Results []api.SearchFile }
	s.call(http.MethodGet, "/api/search/files?q="+url.QueryEscape("zeytinyağı"), mert, nil, &files)
	if len(files.Results) != 1 || files.Results[0].Excerpt == nil || !strings.Contains(*files.Results[0].Excerpt, "«zeytinyağı»") {
		t.Fatalf("file by content = %+v", files.Results)
	}
	s.call(http.MethodGet, "/api/search/files?q=notlar", mert, nil, &files)
	if len(files.Results) != 1 || *files.Results[0].Excerpt != "" {
		t.Errorf("file by name = %+v", files.Results)
	}

	// Canvases and list rows of one's channels.
	var tab api.Tab
	s.call(http.MethodPost, "/api/channels/"+general+"/tabs", ayse, map[string]any{"kind": "canvas", "title": "Yol haritası"}, &tab)
	path := "/api/canvases/" + tab.CanvasId.String()
	var cv api.Canvas
	s.call(http.MethodPost, path+"/editing", ayse, nil, &cv)
	s.call(http.MethodPut, path, ayse, map[string]any{"body": "# Plan\n\nÜçüncü çeyrekte masaüstü uygulaması.", "version": cv.Version}, nil)
	list := map[string]any{}
	s.call(http.MethodPost, "/api/channels/"+general+"/tabs", ayse, map[string]any{"kind": "list", "title": "Görevler"}, &list)
	s.call(http.MethodPost, "/api/lists/"+list["list_id"].(string)+"/items", ayse, map[string]any{"title": "Masaüstü imzalama sertifikası"}, nil)

	var content struct {
		Canvases []struct {
			Title, Excerpt string
		}
		Items []struct {
			Title     string
			ListTitle string `json:"list_title"`
		}
	}
	s.call(http.MethodGet, "/api/search/content?q="+url.QueryEscape("masaüstü"), mert, nil, &content)
	if len(content.Canvases) != 1 || content.Canvases[0].Title != "Yol haritası" || !strings.Contains(content.Canvases[0].Excerpt, "«masaüstü»") {
		t.Errorf("canvases = %+v", content.Canvases)
	}
	if len(content.Items) != 1 || content.Items[0].Title != "Masaüstü imzalama sertifikası" {
		t.Errorf("items = %+v", content.Items)
	}

	// Channels one is not in stay out.
	var ch struct{ ID string }
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"workspace_id": s.defaultWS, "name": "yönetim", "visibility": "private"}, &ch)
	var other api.Tab
	s.call(http.MethodPost, "/api/channels/"+ch.ID+"/tabs", admin, map[string]any{"kind": "canvas", "title": "Gizli"}, &other)
	p := "/api/canvases/" + other.CanvasId.String()
	s.call(http.MethodPost, p+"/editing", admin, nil, &cv)
	s.call(http.MethodPut, p, admin, map[string]any{"body": "masaüstü gizli notu", "version": cv.Version}, nil)
	s.call(http.MethodGet, "/api/search/content?q="+url.QueryEscape("masaüstü"), mert, nil, &content)
	if len(content.Canvases) != 1 {
		t.Errorf("another channel's canvas shows: %+v", content.Canvases)
	}
}

// The file search before it looked up name and text apart (0.99.4), kept to
// check that the new one finds the same files in the same order.
const searchFilesBefore = `SELECT f.id::text
FROM files f
JOIN channel_members cm ON cm.channel_id = f.channel_id AND cm.user_id = $2
JOIN channels c ON c.id = f.channel_id
JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
WHERE f.message_id IS NOT NULL AND f.status = 'ready'
  AND (cenacle_search_vector(f.name) @@ cenacle_search_query($1)
       OR (f.content_text IS NOT NULL AND cenacle_search_vector(f.content_text) @@ cenacle_search_query($1)))
  AND ($3::uuid IS NULL OR f.id < $3::uuid)
ORDER BY f.id DESC
LIMIT $4`

// Name and text are searched apart: a file found both ways comes once, the order
// and the pages are those of one search, and files of channels one is not in, or of
// deleted messages, stay out either way.
func TestFileSearchNameAndText(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	ctx := context.Background()
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	mert := s.user("sub-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	var private struct{ ID string }
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"workspace_id": s.defaultWS, "name": "yönetim", "visibility": "private"}, &private)

	n := 0
	attach := func(token, channel, name, text string) (file, msg string) {
		t.Helper()
		f := s.uploadFile(token, channel, name, "text/plain", []byte(text))
		n++
		var m message
		if res := s.call(http.MethodPost, "/api/channels/"+channel+"/messages", token, map[string]any{
			"body": "", "nonce": fmt.Sprintf("fs-nonce-%d", n), "file_ids": []string{f.ID},
		}, &m); res.StatusCode != http.StatusCreated {
			t.Fatalf("send %s = %d", name, res.StatusCode)
		}
		return f.ID, m.ID
	}
	byName, _ := attach(ayse, general, "rapor-ocak.txt", "Zeytin hasadı bitti.")
	byText, _ := attach(ayse, general, "notlar.txt", "Rapor taslağı: zeytin fiyatları.")
	both, _ := attach(ayse, general, "rapor-şubat.txt", "Rapor özeti.")
	attach(admin, private.ID, "rapor-gizli.txt", "Rapor ve zeytin, yönetim için.")
	_, deleted := attach(ayse, general, "rapor-silinen.txt", "Rapor, silinecek.")
	attach(ayse, general, "resim.txt", "Başka bir şey.")
	if res := s.call(http.MethodDelete, "/api/channels/"+general+"/messages/"+deleted, ayse, nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete message = %d", res.StatusCode)
	}
	reader := &chat.FileTextReader{Queries: store.New(s.pool), Files: s.bg.Files}
	if got, err := reader.Run(ctx); err != nil || got != 6 {
		t.Fatalf("read texts = %d %v", got, err)
	}

	type page struct {
		Results []api.SearchFile
		HasMore bool `json:"has_more"`
	}
	search := func(q string, limit int, before string) page {
		t.Helper()
		path := "/api/search/files?q=" + url.QueryEscape(q) + "&limit=" + strconv.Itoa(limit)
		if before != "" {
			path += "&before=" + before
		}
		var p page
		if res := s.call(http.MethodGet, path, mert, nil, &p); res.StatusCode != http.StatusOK {
			t.Fatalf("%s = %d", path, res.StatusCode)
		}
		return p
	}
	ids := func(p page) []string {
		out := []string{}
		for _, f := range p.Results {
			out = append(out, f.Id.String())
		}
		return out
	}

	if got, want := ids(search("rapor", 20, "")), []string{both, byText, byName}; !slices.Equal(got, want) {
		t.Errorf("rapor = %q, want %q (newest first, each once)", got, want)
	}
	first := search("rapor", 2, "")
	if got := ids(first); !slices.Equal(got, []string{both, byText}) || !first.HasMore {
		t.Errorf("first page = %q more=%v", got, first.HasMore)
	}
	second := search("rapor", 2, byText)
	if got := ids(second); !slices.Equal(got, []string{byName}) || second.HasMore {
		t.Errorf("second page = %q more=%v", got, second.HasMore)
	}

	// The same files as the search before, for every page size and cursor.
	mertID := s.userID(mert)
	for _, q := range []string{"rapor", "zeytin", "rap", "notlar", "rapor zeytin", "rapor -zeytin", "silinecek", "gizli", "yok"} {
		for limit := 1; limit <= 4; limit++ {
			before := ""
			for range 5 {
				var want []string
				var cursor any
				if before != "" {
					cursor = before
				}
				rows, err := s.pool.Query(ctx, searchFilesBefore, q, mertID, cursor, limit+1)
				if err != nil {
					t.Fatal(err)
				}
				for rows.Next() {
					var id string
					if err := rows.Scan(&id); err != nil {
						t.Fatal(err)
					}
					want = append(want, id)
				}
				rows.Close()
				more := len(want) > limit
				want = want[:min(len(want), limit)]
				p := search(q, limit, before)
				if got := ids(p); !slices.Equal(got, want) || p.HasMore != more {
					t.Errorf("%q limit %d before %q = %q more=%v, before the change %q more=%v", q, limit, before, got, p.HasMore, want, more)
				}
				if !more {
					break
				}
				before = want[len(want)-1]
			}
		}
	}
}
