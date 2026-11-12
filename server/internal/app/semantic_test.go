// SPDX-License-Identifier: AGPL-3.0-only

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/ai"
	"github.com/Cenacle-TR/cenacle/server/internal/chat"
)

// conceptVector is a stand-in embedding model: words of the same idea (in
// English or Turkish) land on the same dimension, so "release date" is near
// "we ship on the 4th" without a word in common.
func conceptVector(text string) []float32 {
	concepts := [][]string{
		{"release", "ship", "launch", "sürüm", "yayın"},
		{"date", "day", "4th", "when", "tarih"},
		{"lunch", "food", "pizza", "yemek"},
		{"budget", "money", "cost", "bütçe"},
	}
	v := make([]float32, 8)
	for _, w := range strings.Fields(strings.ToLower(text)) {
		w = strings.Trim(w, ".,?!")
		hit := false
		for i, c := range concepts {
			for _, x := range c {
				if strings.HasPrefix(w, x) {
					v[i]++
					hit = true
				}
			}
		}
		if !hit && w != "" {
			v[4+len(w)%4] += 0.2
		}
	}
	var n float64
	for _, x := range v {
		n += float64(x * x)
	}
	if n == 0 {
		v[7], n = 1, 1
	}
	for i := range v {
		v[i] /= float32(math.Sqrt(n))
	}
	return v
}

func fakeEmbedder(t *testing.T) *ai.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		if r.URL.Path != "/v1/embeddings" || json.NewDecoder(r.Body).Decode(&in) != nil || in.Model != "embed" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		data := make([]map[string]any, len(in.Input))
		for i, text := range in.Input {
			data[i] = map[string]any{"index": i, "embedding": conceptVector(text)}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	}))
	t.Cleanup(srv.Close)
	return ai.New(srv.URL+"/v1", "tiny", "", 5*time.Second)
}

func TestSemanticSearch(t *testing.T) {
	sh := newShared(t)
	ctx := context.Background()
	var ext bool
	if err := sh.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')`).Scan(&ext); err != nil || !ext {
		if os.Getenv("CI") != "" {
			t.Fatal("pgvector is missing in the CI database")
		}
		t.Skip("pgvector is not in the test database")
	}
	client := fakeEmbedder(t)
	index := &chat.SemanticIndex{DB: sh.pool, AI: client, Model: "embed", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	s := newStack(t, sh, options{ai: client, semantic: index})
	admin := s.admin()
	ayse := s.user("sem-a", "Ayşe")
	mert := s.user("sem-m", "Mert")
	general := s.general(ayse)
	s.general(mert)
	s.send(mert, general, "We ship on the 4th, finally.", "sem-0001")
	s.send(mert, general, "Pizza for everyone at noon", "sem-0002")
	s.send(mert, general, "The budget needs another look", "sem-0003")

	search := func(token, q string) (int, []string) {
		var out struct {
			Results []struct {
				Body string `json:"body"`
			} `json:"results"`
		}
		res := s.call(http.MethodGet, "/api/search/messages?mode=meaning&workspace_id="+s.defaultWS+"&q="+strings.ReplaceAll(q, " ", "+"), token, nil, &out)
		bodies := []string{}
		for _, r := range out.Results {
			bodies = append(bodies, r.Body)
		}
		return res.StatusCode, bodies
	}
	// Off until the index is made.
	if status, _ := search(ayse, "release date"); status != http.StatusNotFound {
		t.Errorf("before the index = %d", status)
	}
	// AI off in the workspace: nothing is indexed.
	if n, err := index.Run(ctx); err != nil || n != 0 {
		t.Fatalf("first run = %d, %v", n, err)
	}
	s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/ai", admin, map[string]any{"enabled": true}, nil)
	if n, err := index.Run(ctx); err != nil || n < 3 {
		t.Fatalf("indexing = %d, %v", n, err)
	}
	// The notice first.
	if status, _ := search(ayse, "release date"); status != http.StatusForbidden {
		t.Errorf("without the AI notice = %d", status)
	}
	s.call(http.MethodPut, "/api/me/ai", ayse, map[string]any{"accepted": true}, nil)
	status, bodies := search(ayse, "release date")
	if status != http.StatusOK || len(bodies) == 0 || bodies[0] != "We ship on the 4th, finally." {
		t.Fatalf("by meaning = %d %v", status, bodies)
	}
	for _, b := range bodies {
		if strings.Contains(b, "Pizza") {
			t.Errorf("an unrelated message came back: %v", bodies)
		}
	}
	// Edits are indexed again; deleted messages go.
	var msg struct {
		ID string `json:"id"`
	}
	s.call(http.MethodPost, "/api/channels/"+general+"/messages", mert, map[string]any{"body": "Lunch plans?", "nonce": "sem-0004"}, &msg)
	s.call(http.MethodPatch, "/api/channels/"+general+"/messages/"+msg.ID, mert, map[string]any{"body": "What is the budget cost?"}, nil)
	if _, err := index.Run(ctx); err != nil {
		t.Fatal(err)
	}
	_, bodies = search(ayse, "money")
	if len(bodies) == 0 || !strings.Contains(strings.Join(bodies, "|"), "What is the budget cost?") {
		t.Errorf("edited message by meaning: %v", bodies)
	}
	// AI turned off removes the workspace's vectors.
	s.call(http.MethodPut, "/api/workspaces/"+s.defaultWS+"/ai", admin, map[string]any{"enabled": false}, nil)
	var left int
	if err := sh.pool.QueryRow(ctx, `SELECT count(*) FROM message_vectors`).Scan(&left); err != nil || left != 0 {
		t.Errorf("vectors after AI off = %d, %v", left, err)
	}
	// The console tells how it is.
	var st struct {
		State string `json:"state"`
		Model string `json:"model"`
	}
	s.call(http.MethodGet, "/api/admin/semantic-search", admin, nil, &st)
	if st.State != "ready" || st.Model != "embed" {
		t.Errorf("status: %+v", st)
	}
}
