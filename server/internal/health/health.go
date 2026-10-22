// SPDX-License-Identifier: AGPL-3.0-only

// Package health implements liveness (/healthz) and readiness (/readyz) probes.
package health

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/barisshn35/cenacle/server/internal/httpx"
)

// Checker reports whether a dependency is usable.
type Checker interface {
	Name() string
	Check(ctx context.Context) error
}

// CheckFunc adapts a function to Checker.
type CheckFunc struct {
	CheckName string
	Fn        func(ctx context.Context) error
}

func (c CheckFunc) Name() string                    { return c.CheckName }
func (c CheckFunc) Check(ctx context.Context) error { return c.Fn(ctx) }

// Handler serves the probe endpoints.
type Handler struct {
	Checkers []Checker
	Timeout  time.Duration
	Log      *slog.Logger
}

type status struct {
	Status string            `json:"status"`
	Checks map[string]string `json:"checks,omitempty"`
}

// Healthz reports that the process is alive. It never touches dependencies,
// so a failing database does not get the container restarted.
func (h *Handler) Healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, status{Status: "ok"})
}

// Readyz checks all dependencies concurrently. It returns 200 when all pass
// and a 503 problem response listing the failing checks otherwise.
func (h *Handler) Readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), h.Timeout)
	defer cancel()

	results := make(map[string]string, len(h.Checkers))
	var (
		mu     sync.Mutex
		wg     sync.WaitGroup
		failed []string
	)
	for _, c := range h.Checkers {
		wg.Go(func() {
			err := c.Check(ctx)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				results[c.Name()] = "unavailable"
				failed = append(failed, c.Name())
				h.Log.WarnContext(ctx, "readiness check failed",
					"check", c.Name(), "error", err,
					"request_id", httpx.RequestIDFrom(r.Context()))
				return
			}
			results[c.Name()] = "ok"
		})
	}
	wg.Wait()

	if len(failed) > 0 {
		// Dependency error details stay in the logs; the response only says which check failed.
		w.Header().Set("Retry-After", "5")
		httpx.WriteProblem(w, r, httpx.Problem{
			Status: http.StatusServiceUnavailable,
			Code:   httpx.CodeUnavailable,
			Detail: "Not ready: " + joinSorted(failed) + ".",
		})
		return
	}
	writeJSON(w, http.StatusOK, status{Status: "ok", Checks: results})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
