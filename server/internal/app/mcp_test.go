// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// bearer adds an assistant token to every request.
type bearer struct {
	token string
	next  http.RoundTripper
}

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.next.RoundTrip(r)
}

func mcpSession(t *testing.T, s *stack, token string) (*mcp.ClientSession, error) {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-assistant", Version: "1"}, nil)
	return client.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:   s.srv.URL + "/api/mcp",
		HTTPClient: &http.Client{Transport: bearer{token: token, next: http.DefaultTransport}},
		MaxRetries: -1,
	}, nil)
}

// call runs a tool; it returns the structured result, or the tool's error text.
func callTool(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any, out any) string {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if res.IsError {
		var b strings.Builder
		for _, c := range res.Content {
			if tc, ok := c.(*mcp.TextContent); ok {
				b.WriteString(tc.Text)
			}
		}
		return b.String()
	}
	raw, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return ""
}

func TestAssistantsOverMCP(t *testing.T) {
	s := newStack(t, newShared(t), options{})
	admin := s.admin()
	ayse := s.user("mcp-a", "Ayşe")
	mert := s.user("mcp-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	s.send(mert, general, "The release is on Friday", "mcp-0001")
	root, _ := s.send(mert, general, "Who reviews the budget?", "mcp-0002")
	s.call(http.MethodPost, "/api/channels/"+general+"/messages", ayse, map[string]any{"body": "I will", "nonce": "mcp-0003", "root_id": root.ID}, nil)
	// A private channel Ayşe is not in.
	var secret struct {
		ID string `json:"id"`
	}
	s.call(http.MethodPost, "/api/channels", admin, map[string]any{"name": "board", "visibility": "private"}, &secret)

	create := func(scopes ...string) (int, string) {
		var out struct {
			Token string `json:"token"`
		}
		res := s.call(http.MethodPost, "/api/me/assistants", ayse, map[string]any{"name": "Desk", "scopes": scopes, "days": 7}, &out)
		return res.StatusCode, out.Token
	}
	// Off until the administrators allow assistants.
	if status, _ := create("read"); status != http.StatusForbidden {
		t.Fatalf("token while off = %d", status)
	}
	s.call(http.MethodPut, "/api/admin/assistants", admin, map[string]bool{"enabled": true}, nil)
	status, reader := create("read")
	if status != http.StatusCreated || !strings.HasPrefix(reader, "cnp_") {
		t.Fatalf("token = %d %q", status, reader)
	}
	// The token reaches nothing but /api/mcp.
	if res := s.call(http.MethodGet, "/api/channels", reader, nil, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("token on the API = %d", res.StatusCode)
	}
	// A session cannot use the MCP endpoint (only assistant tokens).
	if _, err := mcpSession(t, s, ayse); err == nil {
		t.Error("a session reached /api/mcp")
	}

	cs, err := mcpSession(t, s, reader)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cs.Close() }()
	var channels struct {
		Channels []struct{ ID, Name, Kind string } `json:"channels"`
	}
	callTool(t, cs, "list_channels", nil, &channels)
	names := []string{}
	for _, c := range channels.Channels {
		names = append(names, c.Name)
		if c.ID == secret.ID {
			t.Error("a channel the person is not in was listed")
		}
	}
	if !strings.Contains(strings.Join(names, ","), "General") {
		t.Errorf("channels: %v", names)
	}
	var msgs struct {
		Messages []struct {
			ID      string `json:"id"`
			Text    string `json:"text"`
			Replies int    `json:"replies"`
		} `json:"messages"`
	}
	callTool(t, cs, "read_messages", map[string]any{"channel_id": general}, &msgs)
	if len(msgs.Messages) < 2 || msgs.Messages[0].Text != "Who reviews the budget?" || msgs.Messages[0].Replies != 1 {
		t.Fatalf("messages: %+v", msgs.Messages)
	}
	callTool(t, cs, "read_thread", map[string]any{"channel_id": general, "message_id": root.ID}, &msgs)
	if len(msgs.Messages) != 2 || msgs.Messages[0].Text != "I will" {
		t.Errorf("thread: %+v", msgs.Messages)
	}
	callTool(t, cs, "search_messages", map[string]any{"query": "release"}, &msgs)
	if len(msgs.Messages) != 1 || msgs.Messages[0].Text != "The release is on Friday" {
		t.Errorf("search: %+v", msgs.Messages)
	}
	if e := callTool(t, cs, "read_messages", map[string]any{"channel_id": secret.ID}, &msgs); !strings.Contains(e, "no such channel") {
		t.Errorf("reading a channel the person is not in: %q", e)
	}
	// Read only: no drafts.
	if e := callTool(t, cs, "draft_message", map[string]any{"channel_id": general, "text": "Yes"}, &struct{}{}); !strings.Contains(e, "draft scope") {
		t.Errorf("draft without the scope: %q", e)
	}

	// With the draft scope the draft waits in the message box; nothing is sent.
	_, drafter := create("read", "draft")
	cd, err := mcpSession(t, s, drafter)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cd.Close() }()
	var placed struct {
		Placed string `json:"placed"`
	}
	if e := callTool(t, cd, "draft_message", map[string]any{"channel_id": general, "text": "I can review it on Monday.", "thread_of": root.ID}, &placed); e != "" {
		t.Fatalf("draft: %s", e)
	}
	var drafts struct {
		Drafts []struct {
			ChannelID string  `json:"channel_id"`
			RootID    *string `json:"root_id"`
			Body      string  `json:"body"`
			Assistant string  `json:"assistant"`
		} `json:"drafts"`
	}
	s.call(http.MethodGet, "/api/me/assistant-drafts", ayse, nil, &drafts)
	if len(drafts.Drafts) != 1 || drafts.Drafts[0].Body != "I can review it on Monday." || drafts.Drafts[0].RootID == nil ||
		*drafts.Drafts[0].RootID != root.ID || drafts.Drafts[0].Assistant != "Desk" {
		t.Fatalf("drafts: %+v", drafts.Drafts)
	}
	callTool(t, cs, "read_messages", map[string]any{"channel_id": general}, &msgs)
	for _, m := range msgs.Messages {
		if strings.Contains(m.Text, "Monday") {
			t.Error("the draft was sent")
		}
	}
	s.call(http.MethodDelete, "/api/me/assistant-drafts/"+general, ayse, nil, nil)
	s.call(http.MethodGet, "/api/me/assistant-drafts", ayse, nil, &drafts)
	if len(drafts.Drafts) != 0 {
		t.Errorf("draft after taking it away: %+v", drafts.Drafts)
	}

	// Revoked, a token stops; turning assistants off stops all.
	var list struct {
		Tokens []struct{ ID, Name string } `json:"tokens"`
	}
	s.call(http.MethodGet, "/api/me/assistants", ayse, nil, &list)
	if len(list.Tokens) != 2 {
		t.Fatalf("tokens: %+v", list.Tokens)
	}
	for _, tok := range list.Tokens {
		s.call(http.MethodDelete, "/api/me/assistants/"+tok.ID, ayse, nil, nil)
	}
	if _, err := mcpSession(t, s, reader); err == nil {
		t.Error("a revoked token still works")
	}
	_, again := create("read")
	s.call(http.MethodPut, "/api/admin/assistants", admin, map[string]bool{"enabled": false}, nil)
	if _, err := mcpSession(t, s, again); err == nil {
		t.Error("a token works with assistants off")
	}
}
