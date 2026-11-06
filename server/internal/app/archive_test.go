// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/xml"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func (s *stack) fetch(token, path string) (int, []byte) {
	s.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.client.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, body
}

func TestArchiveExport(t *testing.T) {
	s := newStack(t, newShared(t), options{files: true})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	general := s.general(ayse)
	m, _ := s.send(ayse, general, "Çeyrek raporu hazır", "arc-nonce-1")
	s.reply(admin, general, m.ID, "Teşekkürler", "arc-nonce-2", false)
	since := url.QueryEscape(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339))
	until := url.QueryEscape(time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	archive := "/api/workspaces/" + s.defaultWS + "/archive?since=" + since + "&until=" + until + "&format="

	if status, _ := s.fetch(ayse, archive+"csv"); status != http.StatusForbidden {
		t.Errorf("member exports = %d", status)
	}
	status, body := s.fetch(admin, archive+"csv")
	rows, err := csv.NewReader(bytes.NewReader(body)).ReadAll()
	if status != http.StatusOK || err != nil || len(rows) != 3 || rows[1][9] != "Çeyrek raporu hazır" || rows[2][8] != m.ID {
		t.Fatalf("csv = %d %v %v", status, err, rows)
	}
	status, body = s.fetch(admin, archive+"actiance")
	var dump struct {
		Conversations []struct {
			RoomID   string
			Messages []struct{ Content string } `xml:"Message"`
		} `xml:"Conversation"`
	}
	if err := xml.Unmarshal(body, &dump); status != http.StatusOK || err != nil || len(dump.Conversations) != 1 || len(dump.Conversations[0].Messages) != 2 || dump.Conversations[0].RoomID != general {
		t.Fatalf("actiance = %d %v %s", status, err, body)
	}
	status, body = s.fetch(admin, archive+"eml")
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if status != http.StatusOK || err != nil || len(zr.File) != 2 {
		t.Fatalf("eml = %d %v", status, err)
	}
	f, _ := zr.File[0].Open()
	eml, _ := io.ReadAll(f)
	if !strings.Contains(string(eml), "Message-ID: <"+m.ID+"@") || !strings.Contains(string(eml), "Content-Transfer-Encoding: base64") {
		t.Errorf("eml = %s", eml)
	}

	// Daily: yesterday's messages are written to the object store.
	schedule := "/api/workspaces/" + s.defaultWS + "/archive-schedule"
	var sched api.ArchiveSchedule
	if res := s.call(http.MethodPut, schedule, admin, map[string]string{"format": "csv"}, &sched); res.StatusCode != http.StatusOK || sched.Format != "csv" || !sched.Available {
		t.Fatalf("schedule = %d %+v", res.StatusCode, sched)
	}
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `UPDATE messages SET created_at = created_at - interval '1 day'`); err != nil {
		t.Fatal(err)
	}
	exporter := &chat.ArchiveExporter{Queries: store.New(s.pool), Files: s.bg.Files, Host: "chat.test"}
	if n, err := exporter.Run(ctx); err != nil || n != 1 {
		t.Fatalf("exporter = %d %v", n, err)
	}
	if n, _ := exporter.Run(ctx); n != 0 {
		t.Errorf("exported again = %d", n)
	}
	s.call(http.MethodGet, schedule, admin, nil, &sched)
	if len(sched.Exports) != 1 || sched.Exports[0].Messages != 2 {
		t.Fatalf("exports = %+v", sched.Exports)
	}
	status, body = s.fetch(admin, "/api/archive-exports/"+sched.Exports[0].Id.String())
	if status != http.StatusOK || !strings.Contains(string(body), "Çeyrek raporu hazır") {
		t.Errorf("download = %d %s", status, body)
	}
}
