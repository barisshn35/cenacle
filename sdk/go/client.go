// SPDX-License-Identifier: Apache-2.0

package cenacle

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client calls Cenacle's API with a bot token (cnb_…).
type Client struct {
	// BaseURL is the chat server's address, e.g. https://chat.example.com.
	BaseURL string
	Token   string
	// HTTP is the client used (http.DefaultClient with a timeout when nil).
	HTTP *http.Client
}

// Error is an error answer of the API (application/problem+json).
type Error struct {
	Status int    `json:"status"`
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("cenacle: %d %s: %s", e.Status, e.Code, e.Detail)
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(c.BaseURL, "/")+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	h := c.HTTP
	if h == nil {
		h = &http.Client{Timeout: 30 * time.Second}
	}
	res, err := h.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		e := &Error{Status: res.StatusCode}
		_ = json.Unmarshal(raw, e)
		return e
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func nonce() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "sdk-" + hex.EncodeToString(b)
}

// Post is a message to send.
type Post struct {
	Text        string
	Attachments []Attachment
	// RootID replies in a thread.
	RootID string
	// Nonce makes retries safe (a random one when empty).
	Nonce string
}

// PostMessage sends a message to a channel the bot is in.
func (c *Client) PostMessage(ctx context.Context, channelID string, p Post) (Message, error) {
	in := map[string]any{"body": p.Text, "nonce": p.Nonce}
	if p.Nonce == "" {
		in["nonce"] = nonce()
	}
	if len(p.Attachments) > 0 {
		in["attachments"] = p.Attachments
	}
	if p.RootID != "" {
		in["root_id"] = p.RootID
	}
	var out Message
	err := c.do(ctx, http.MethodPost, "/api/channels/"+url.PathEscape(channelID)+"/messages", in, &out)
	return out, err
}

// React adds an emoji reaction to a message.
func (c *Client) React(ctx context.Context, channelID, messageID, emoji string) error {
	return c.do(ctx, http.MethodPut, "/api/channels/"+url.PathEscape(channelID)+"/messages/"+url.PathEscape(messageID)+
		"/reactions/"+url.PathEscape(emoji), nil, nil)
}
