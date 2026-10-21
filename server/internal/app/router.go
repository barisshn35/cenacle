// SPDX-License-Identifier: Apache-2.0

// Package app wires HTTP routes and middleware.
package app

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/auth"
	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/health"
	"github.com/barisshn35/cenacle/server/internal/httpx"
	"github.com/barisshn35/cenacle/server/internal/realtime"
)

// Deps are the dependencies of the HTTP layer.
type Deps struct {
	Log          *slog.Logger
	Checkers     []health.Checker
	ReadyTimeout time.Duration
	// Auth, Chat and Realtime serve the API; without Auth only the probes
	// are mounted.
	Auth     *auth.Handlers
	Chat     *chat.Handlers
	Realtime *realtime.Handler
}

// apiServer implements the generated api.ServerInterface by composing the
// handlers of each domain.
type apiServer struct {
	*authHandlers
	*chatHandlers
	*realtime.Handler
}

// Aliases give the embedded handler types distinct field names.
type (
	authHandlers = auth.Handlers
	chatHandlers = chat.Handlers
)

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

	if d.Auth != nil {
		a := d.Auth
		r.Group(func(r chi.Router) {
			r.Use(auth.SameOrigin(a.PublicURL, a.Cookies))
			r.Use(auth.Authenticate(a.Sessions, a.Cookies, a.TrustProxy, d.Log))
			if d.Realtime != nil {
				r.Get("/ws", d.Realtime.ServeWS)
			}
			api.HandlerWithOptions(apiServer{a, d.Chat, d.Realtime}, api.ChiServerOptions{
				BaseRouter:       r,
				ErrorHandlerFunc: badRequest,
			})
		})
	}

	return r
}

// badRequest answers requests whose parameters do not match the API spec.
func badRequest(w http.ResponseWriter, r *http.Request, err error) {
	httpx.WriteProblem(w, r, httpx.Problem{
		Status: http.StatusBadRequest,
		Code:   httpx.CodeBadRequest,
		Detail: err.Error(),
	})
}
