// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"net/http"
	"net/url"
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
