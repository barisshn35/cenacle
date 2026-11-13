// SPDX-License-Identifier: AGPL-3.0-only

package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// hosted serves like a hosted model: over HTTPS and only with its key.
func hosted(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k-1" {
			http.Error(w, `{"error":{"message":"invalid key"}}`, http.StatusUnauthorized)
			return
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL+"/v1/", "chat-model", "k-1", 5*time.Second)
	c.HTTP.Transport = srv.Client().Transport
	return c
}

func TestCompleteSendsTheKeyAndALimit(t *testing.T) {
	var got map[string]any
	c := hosted(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"  Kısa özet.  "},"finish_reason":"stop"}],"usage":{"total_tokens":9}}`))
	})
	text, err := c.Complete(context.Background(), "system", "user")
	if err != nil || text != "Kısa özet." {
		t.Fatalf("Complete = %q, %v", text, err)
	}
	if got["model"] != "chat-model" || got["max_tokens"] != float64(maxTokens) || got["stream"] != false {
		t.Errorf("request = %v", got)
	}
}

func TestFailuresOfTheModelServer(t *testing.T) {
	for _, tc := range []struct {
		name string
		h    http.HandlerFunc
	}{
		{"rate limited", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":{"message":"rate limit"}}`, http.StatusTooManyRequests)
		}},
		{"a parameter refused", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":{"message":"unsupported parameter"}}`, http.StatusBadRequest)
		}},
		{"no choices", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"choices":[]}`)) }},
		{"not JSON", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`<html>`)) }},
		{"a redirect (not followed)", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://elsewhere.example/v1/chat/completions", http.StatusTemporaryRedirect)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := hosted(t, tc.h)
			if _, err := c.Complete(context.Background(), "s", "u"); !errors.Is(err, ErrModel) {
				t.Errorf("Complete = %v", err)
			}
			if _, err := c.Embed(context.Background(), "e", []string{"a"}); !errors.Is(err, ErrModel) {
				t.Errorf("Embed = %v", err)
			}
		})
	}
	// A wrong key is the server's refusal too.
	c := hosted(t, func(http.ResponseWriter, *http.Request) {})
	c.APIKey = "wrong"
	if _, err := c.Complete(context.Background(), "s", "u"); !errors.Is(err, ErrModel) {
		t.Errorf("wrong key = %v", err)
	}
}

func TestEmbedPutsVectorsInTheirPlace(t *testing.T) {
	c := hosted(t, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Input []string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		// Out of order, wide, and with the fields hosted services add.
		data := []map[string]any{}
		for i := len(in.Input) - 1; i >= 0; i-- {
			v := make([]float32, 1536)
			v[0] = float32(i + 1)
			data = append(data, map[string]any{"object": "embedding", "index": i, "embedding": v})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data, "usage": map[string]int{"total_tokens": 3}})
	})
	vs, err := c.Embed(context.Background(), "e", []string{"a", "b", "c"})
	if err != nil || len(vs) != 3 {
		t.Fatalf("Embed = %d, %v", len(vs), err)
	}
	for i, v := range vs {
		if len(v) != 1536 || v[0] != float32(i+1) {
			t.Errorf("vector %d: %d wide, first %v", i, len(v), v[0])
		}
	}
}

func TestEmbedRefusesMismatchedAnswers(t *testing.T) {
	for name, body := range map[string]string{
		"fewer vectors":    `{"data":[{"index":0,"embedding":[1]}]}`,
		"an index twice":   `{"data":[{"index":0,"embedding":[1]},{"index":0,"embedding":[2]}]}`,
		"different widths": `{"data":[{"index":0,"embedding":[1]},{"index":1,"embedding":[1,2]}]}`,
		"an empty vector":  `{"data":[{"index":0,"embedding":[]},{"index":1,"embedding":[1]}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			c := hosted(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) })
			if _, err := c.Embed(context.Background(), "e", []string{"a", "b"}); !errors.Is(err, ErrModel) {
				t.Errorf("Embed = %v", err)
			}
		})
	}
}
