// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/egress"
	"github.com/Cenacle-TR/cenacle/server/internal/integrations/signing"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

func TestInstanceAudit(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/invites", admin, map[string]any{}, nil)
	s.call(http.MethodPut, "/api/admin/notification-policy", admin, api.NotificationPolicy{PushContents: "sender", EmailContents: "full"}, nil)

	if status, _ := problemCode(t, s, http.MethodGet, "/api/admin/audit", ayse, nil); status != http.StatusForbidden {
		t.Errorf("member reads the audit log = %d", status)
	}
	var page struct {
		Events  []api.AuditEvent
		HasMore bool `json:"has_more"`
	}
	s.call(http.MethodGet, "/api/admin/audit?prefix=instance.", admin, nil, &page)
	if len(page.Events) != 1 || page.Events[0].Action != "instance.notification_policy_changed" || page.Events[0].Workspace != nil {
		t.Fatalf("instance events = %+v", page.Events)
	}
	s.call(http.MethodGet, "/api/admin/audit?limit=1", admin, nil, &page)
	if len(page.Events) != 1 || !page.HasMore {
		t.Errorf("first page = %d %v", len(page.Events), page.HasMore)
	}
	var all struct{ Events []api.AuditEvent }
	s.call(http.MethodGet, "/api/admin/audit", admin, nil, &all)
	var invite *api.AuditEvent
	for i, e := range all.Events {
		if strings.HasPrefix(e.Action, "invite.") {
			invite = &all.Events[i]
		}
	}
	if invite == nil || invite.Workspace == nil || invite.Workspace.Name == "" {
		t.Errorf("workspace event = %+v", invite)
	}

	// The download has every event, the export itself first.
	res, err := s.client.Do(func() *http.Request {
		req, _ := http.NewRequest(http.MethodGet, s.srv.URL+"/api/admin/audit/export", nil)
		req.Header.Set("Authorization", "Bearer "+admin)
		return req
	}())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	var first struct{ Action, Server string }
	_ = json.Unmarshal([]byte(lines[0]), &first)
	if res.StatusCode != http.StatusOK || len(lines) != len(all.Events)+1 || first.Action != "instance.audit_exported" || first.Server == "" {
		t.Errorf("export = %d, %d lines, first %+v", res.StatusCode, len(lines), first)
	}
}

func TestAuditStream(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("sub-a", "Ayşe")
	const path = "/api/admin/audit-stream"
	client := egress.New(egress.Policy{
		Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}, AllowHTTP: true,
	})
	forwarder := &chat.AuditForwarder{Queries: store.New(s.pool), Egress: client, Server: s.srv.URL}

	// HTTP: signed NDJSON of what is written after it was turned on.
	var mu sync.Mutex
	var got []string
	var signed bool
	siem := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		signed = signing.Verify("siem-secret", r.Header.Get(signing.Header), body, time.Now(), time.Minute)
		for _, l := range strings.Split(strings.TrimSpace(string(body)), "\n") {
			var e struct{ Action string }
			_ = json.Unmarshal([]byte(l), &e)
			got = append(got, e.Action)
		}
	}))
	t.Cleanup(siem.Close)
	if status, _ := problemCode(t, s, http.MethodPut, path, admin, map[string]any{"kind": "syslog", "address": "no-port", "tls": false}); status != http.StatusBadRequest {
		t.Errorf("bad syslog address = %d", status)
	}
	var stream api.AuditStream
	if res := s.call(http.MethodPut, path, admin, map[string]any{"kind": "http", "address": siem.URL, "tls": false, "secret": "siem-secret"}, &stream); res.StatusCode != http.StatusOK || stream.HasSecret == nil || !*stream.HasSecret {
		t.Fatalf("set = %d %+v", res.StatusCode, stream)
	}
	s.call(http.MethodPost, "/api/workspaces/"+s.defaultWS+"/invites", admin, map[string]any{}, nil)
	if n, err := forwarder.Run(context.Background()); err != nil || n != 2 {
		t.Fatalf("forward = %d %v", n, err)
	}
	mu.Lock()
	if !signed || len(got) != 2 || got[0] != "instance.audit_stream_changed" || !strings.HasPrefix(got[1], "invite.") {
		t.Errorf("SIEM got %v (signed %v)", got, signed)
	}
	mu.Unlock()
	if n, _ := forwarder.Run(context.Background()); n != 0 {
		t.Errorf("sent again = %d", n)
	}
	s.call(http.MethodGet, path, ayse, nil, nil)

	// Syslog: RFC 5424 frames with octet counting.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	frames := make(chan string, 10)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		r := bufio.NewReader(conn)
		for {
			size, err := r.ReadString(' ')
			if err != nil {
				return
			}
			n, _ := strconv.Atoi(strings.TrimSpace(size))
			buf := make([]byte, n)
			if _, err := io.ReadFull(r, buf); err != nil {
				return
			}
			frames <- string(buf)
		}
	}()
	s.call(http.MethodPut, path, admin, map[string]any{"kind": "syslog", "address": ln.Addr().String(), "tls": false}, nil)
	if n, err := forwarder.Run(context.Background()); err != nil || n != 1 {
		t.Fatalf("syslog forward = %d %v", n, err)
	}
	select {
	case f := <-frames:
		if !strings.HasPrefix(f, "<85>1 ") || !strings.Contains(f, " cenacle - instance.audit_stream_changed - {") {
			t.Errorf("frame = %q", f)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no syslog frame")
	}

	// An unreachable receiver keeps the events for the next try.
	_ = ln.Close()
	s.call(http.MethodPut, path, admin, map[string]any{"kind": "http", "address": "http://127.0.0.1:1/x", "tls": false}, nil)
	if _, err := forwarder.Run(context.Background()); err == nil {
		t.Error("an unreachable SIEM did not fail")
	}
	s.call(http.MethodGet, path, admin, nil, &stream)
	if stream.LastError == nil || *stream.LastError == "" {
		t.Errorf("last error = %v", stream.LastError)
	}
}
