// SPDX-License-Identifier: AGPL-3.0-only

// Package ai talks to a language model the operator runs, through the
// OpenAI-compatible chat completions API that Ollama, vLLM, llama.cpp and
// LocalAI serve. Nothing leaves for a third party unless the operator points
// it there.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client calls one model.
type Client struct {
	URL    string // e.g. http://ollama:11434/v1
	Model  string
	APIKey string
	HTTP   *http.Client
}

// New returns a client, or nil when no model is configured.
func New(url, model, apiKey string, timeout time.Duration) *Client {
	if url == "" || model == "" {
		return nil
	}
	return &Client{URL: strings.TrimRight(url, "/"), Model: model, APIKey: apiKey,
		HTTP: &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}}
}

// Host is the model server's host and port, as people are told where their
// requests go.
func (c *Client) Host() string {
	if u, err := url.Parse(c.URL); err == nil {
		return u.Host
	}
	return ""
}

// maxTokens bounds an answer (about 750 words).
const maxTokens = 1024

// ErrModel is a failure of the model's server.
var ErrModel = errors.New("ai: the model did not answer")

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Complete asks the model with instructions (system) and the input (user).
func (c *Client) Complete(ctx context.Context, system, user string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":       c.Model,
		"messages":    []message{{Role: "system", Content: system}, {Role: "user", Content: user}},
		"temperature": 0.2,
		// Summaries, rewrites and answers are short; without a limit a model that
		// keeps writing holds the request until the timeout.
		"max_tokens": maxTokens,
		"stream":     false,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Cenacle")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrModel, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrModel, err)
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%w: status %d", ErrModel, res.StatusCode)
	}
	var out struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
		return "", fmt.Errorf("%w: no answer", ErrModel)
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

// maxEmbedInput bounds the text of one input (in runes).
const maxEmbedInput = 2000

// Embed asks a model for the vectors of texts (the OpenAI-compatible
// embeddings API), in their order.
func (c *Client) Embed(ctx context.Context, model string, texts []string) ([][]float32, error) {
	input := make([]string, len(texts))
	for i, t := range texts {
		if r := []rune(t); len(r) > maxEmbedInput {
			t = string(r[:maxEmbedInput])
		}
		input[i] = t
	}
	body, _ := json.Marshal(map[string]any{"model": model, "input": input})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Cenacle")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrModel, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrModel, err)
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrModel, res.StatusCode)
	}
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Data) != len(texts) {
		return nil, fmt.Errorf("%w: no vectors", ErrModel)
	}
	vectors := make([][]float32, len(texts))
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= len(texts) || len(d.Embedding) == 0 || vectors[d.Index] != nil {
			return nil, fmt.Errorf("%w: unexpected vectors", ErrModel)
		}
		vectors[d.Index] = d.Embedding
	}
	dims := len(vectors[0])
	for _, v := range vectors {
		if len(v) != dims {
			return nil, fmt.Errorf("%w: vectors of different widths", ErrModel)
		}
	}
	return vectors, nil
}
