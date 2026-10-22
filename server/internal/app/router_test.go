// SPDX-License-Identifier: AGPL-3.0-only

package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/health"
	"github.com/barisshn35/cenacle/server/internal/httpx"
)

func newServer(t *testing.T, checkers ...health.Checker) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(NewRouter(Deps{
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		Checkers:     checkers,
		ReadyTimeout: time.Second,
	}))
	t.Cleanup(srv.Close)
	return srv
}

func check(name string, err error) health.Checker {
	return health.CheckFunc{CheckName: name, Fn: func(context.Context) error { return err }}
}

func get(t *testing.T, url string) (*http.Response, []byte) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func TestHealthz(t *testing.T) {
	srv := newServer(t, check("postgres", errors.New("down")))
	res, body := get(t, srv.URL+"/healthz")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if !strings.Contains(string(body), `"status":"ok"`) {
		t.Errorf("body = %s", body)
	}
	if res.Header.Get(httpx.RequestIDHeader) == "" {
		t.Error("missing request id header")
	}
}

func TestReadyzAllHealthy(t *testing.T) {
	srv := newServer(t, check("postgres", nil), check("valkey", nil))
	res, body := get(t, srv.URL+"/readyz")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body = %s", res.StatusCode, body)
	}
	var s struct {
		Checks map[string]string `json:"checks"`
	}
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatal(err)
	}
	if s.Checks["postgres"] != "ok" || s.Checks["valkey"] != "ok" {
		t.Errorf("checks = %v", s.Checks)
	}
}

func TestReadyzDependencyDown(t *testing.T) {
	srv := newServer(t, check("postgres", nil), check("valkey", errors.New("dial tcp: refused")))
	res, body := get(t, srv.URL+"/readyz")
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != httpx.ProblemContentType {
		t.Errorf("Content-Type = %q", ct)
	}
	var p httpx.Problem
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	if p.Code != httpx.CodeUnavailable || !strings.Contains(p.Detail, "valkey") {
		t.Errorf("problem = %+v", p)
	}
	if strings.Contains(string(body), "refused") {
		t.Error("internal error detail leaked")
	}
}

func TestUnknownRouteIsProblemJSON(t *testing.T) {
	srv := newServer(t)
	res, body := get(t, srv.URL+"/does-not-exist")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != httpx.ProblemContentType {
		t.Errorf("Content-Type = %q", ct)
	}
	var p httpx.Problem
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	if p.Type != "about:blank" || p.Title != "Not Found" || p.Status != 404 || p.Code != httpx.CodeNotFound {
		t.Errorf("problem = %+v", p)
	}
	if p.RequestID == "" || p.RequestID != res.Header.Get(httpx.RequestIDHeader) {
		t.Errorf("request_id %q does not match header %q", p.RequestID, res.Header.Get(httpx.RequestIDHeader))
	}
}

func TestWrongMethodIsProblemJSON(t *testing.T) {
	srv := newServer(t)
	res, err := http.Post(srv.URL+"/healthz", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != httpx.ProblemContentType {
		t.Errorf("Content-Type = %q", ct)
	}
}
