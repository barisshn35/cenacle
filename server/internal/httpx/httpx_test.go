// SPDX-License-Identifier: AGPL-3.0-only

package httpx

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteProblemDefaults(t *testing.T) {
	var gotID string
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotID = RequestIDFrom(r.Context())
		WriteProblem(w, r, Problem{Status: http.StatusConflict, Code: "conflict"})
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != ProblemContentType {
		t.Errorf("Content-Type = %q", ct)
	}
	var p Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.Type != "about:blank" || p.Title != "Conflict" || p.Status != 409 || p.Code != "conflict" {
		t.Errorf("problem = %+v", p)
	}
	if p.RequestID == "" || p.RequestID != gotID || rec.Header().Get(RequestIDHeader) != gotID {
		t.Errorf("request id mismatch: body %q ctx %q header %q", p.RequestID, gotID, rec.Header().Get(RequestIDHeader))
	}
}

func TestRequestIDReusesValidIncomingID(t *testing.T) {
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(RequestIDHeader, "proxy-abc-12345")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get(RequestIDHeader); got != "proxy-abc-12345" {
		t.Errorf("request id = %q", got)
	}
}

func TestRequestIDReplacesInvalidIncomingID(t *testing.T) {
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(RequestIDHeader, "<script>alert(1)</script>")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get(RequestIDHeader); !strings.HasPrefix(got, "REQ-") {
		t.Errorf("request id = %q, want generated", got)
	}
}

func TestRecovererWritesProblem(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	h := RequestID(Recoverer(log)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	body, _ := io.ReadAll(rec.Body)
	if strings.Contains(string(body), "boom") {
		t.Error("panic value leaked to client")
	}
	if !strings.Contains(logs.String(), "boom") {
		t.Error("panic not logged")
	}
}

func TestSecurityHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {})).
		ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/me", nil))
	for name, want := range map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"Referrer-Policy":              "no-referrer",
		"Cross-Origin-Resource-Policy": "same-origin",
	} {
		if got := rec.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}
