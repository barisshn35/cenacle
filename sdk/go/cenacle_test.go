// SPDX-License-Identifier: Apache-2.0

package cenacle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVerify(t *testing.T) {
	body := []byte(`{"a":1}`)
	now := time.Now()
	h := Sign("cns_x", now, body)
	if !Verify("cns_x", h, body, now) {
		t.Fatal("own signature does not verify")
	}
	for name, ok := range map[string]bool{
		"other secret": Verify("cns_y", h, body, now),
		"other body":   Verify("cns_x", h, []byte(`{"a":2}`), now),
		"too old":      Verify("cns_x", h, body, now.Add(6*time.Minute)),
		"garbage":      Verify("cns_x", "v1=zz", body, now),
	} {
		if ok {
			t.Errorf("%s verified", name)
		}
	}
}

func signed(t *testing.T, h http.Handler, secret string, v any) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(v)
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(body)))
	req.Header.Set(SignatureHeader, Sign(secret, time.Now(), body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHandlers(t *testing.T) {
	ih := InteractionHandler("cns_s", func(_ context.Context, in Interaction) (InteractionResponse, error) {
		if in.Type == "dialog_submission" && in.Values["reason"] == "" {
			return InteractionResponse{Errors: map[string]string{"reason": "Say why."}}, nil
		}
		return InteractionResponse{Text: "pressed " + in.ActionID}, nil
	})
	rec := signed(t, ih, "cns_s", Interaction{Type: "action", ActionID: "approve"})
	var out InteractionResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != http.StatusOK || out.Text != "pressed approve" {
		t.Errorf("interaction = %d %s", rec.Code, rec.Body)
	}
	rec = signed(t, ih, "cns_s", Interaction{Type: "dialog_submission", Values: map[string]any{"reason": ""}})
	if !strings.Contains(rec.Body.String(), "Say why.") {
		t.Errorf("errors = %s", rec.Body)
	}
	if rec := signed(t, ih, "cns_other", Interaction{}); rec.Code != http.StatusUnauthorized {
		t.Errorf("forged = %d", rec.Code)
	}

	ch := CommandHandler("cns_c", func(_ context.Context, c Command) (CommandResponse, error) {
		return CommandResponse{ResponseType: "in_channel", Text: c.Command + " " + c.Text}, nil
	})
	if rec := signed(t, ch, "cns_c", Command{Command: "/deploy", Text: "api"}); !strings.Contains(rec.Body.String(), `"/deploy api"`) {
		t.Errorf("command = %s", rec.Body)
	}
	eh := EventHandler("cns_e", func(_ context.Context, ev Event) error {
		if ev.Type != "message.created" {
			return errors.New("unexpected")
		}
		return nil
	})
	if rec := signed(t, eh, "cns_e", Event{Type: "message.created"}); rec.Code != http.StatusNoContent {
		t.Errorf("event = %d", rec.Code)
	}
	if rec := signed(t, eh, "cns_e", Event{Type: "other"}); rec.Code != http.StatusInternalServerError {
		t.Errorf("failing event = %d", rec.Code)
	}
}

func TestClient(t *testing.T) {
	var got struct {
		Auth string
		Body map[string]any
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Auth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got.Body)
		if r.URL.Path == "/api/channels/c1/messages" {
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"id":"m1","channel_id":"c1","body":"hi","attachments":[]}`)
			return
		}
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"status":403,"code":"forbidden","detail":"no"}`)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL + "/", Token: "cnb_t"}
	m, err := c.PostMessage(context.Background(), "c1", Post{Text: "hi", Attachments: []Attachment{{Title: "x"}}})
	if err != nil || m.ID != "m1" || got.Auth != "Bearer cnb_t" || !strings.HasPrefix(got.Body["nonce"].(string), "sdk-") {
		t.Fatalf("post = %+v %v %+v", m, err, got)
	}
	err = c.React(context.Background(), "c1", "m1", "👍")
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden || apiErr.Code != "forbidden" {
		t.Errorf("error = %v", err)
	}
}

// The server's signing (internal/integrations/signing) gives this value.
func TestSignMatchesServer(t *testing.T) {
	const want = "t=1761300000,v1=ec934ea08f890ec4f071002edaba61efc173b8e392057d8f219b92fc6f9f94bc"
	if got := Sign("cns_vector", time.Unix(1761300000, 0), []byte(`{"type":"action"}`)); got != want {
		t.Errorf("Sign = %s", got)
	}
}
