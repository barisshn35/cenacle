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
		"stream":      false,
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
