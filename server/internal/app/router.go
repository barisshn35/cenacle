// SPDX-License-Identifier: Apache-2.0

// Package app wires HTTP routes and middleware.
package app

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/barisshn35/cenacle/server/internal/health"
	"github.com/barisshn35/cenacle/server/internal/httpx"
)

// Deps are the dependencies of the HTTP layer.
type Deps struct {
	Log          *slog.Logger
	Checkers     []health.Checker
	ReadyTimeout time.Duration
}

// NewRouter returns the root handler. Every error response, including
// unknown routes and panics, is application/problem+json with a request ID.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(httpx.RequestID)
	r.Use(httpx.AccessLog(d.Log))
	r.Use(httpx.Recoverer(d.Log))
	r.Use(httpx.SecurityHeaders)
	r.NotFound(httpx.NotFound)
	r.MethodNotAllowed(httpx.MethodNotAllowed)

	h := &health.Handler{Checkers: d.Checkers, Timeout: d.ReadyTimeout, Log: d.Log}
	r.Get("/healthz", h.Healthz)
	r.Get("/readyz", h.Readyz)

	return r
}
