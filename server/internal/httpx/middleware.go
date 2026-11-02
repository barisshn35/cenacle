// SPDX-License-Identifier: AGPL-3.0-only

package httpx

import (
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// Recoverer converts panics into a logged 500 problem response.
func Recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec)
				}
				log.ErrorContext(r.Context(), "panic serving request",
					"request_id", RequestIDFrom(r.Context()),
					"panic", rec,
					"stack", string(debug.Stack()),
				)
				WriteProblem(w, r, Problem{Status: http.StatusInternalServerError, Code: CodeInternal})
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// AccessLog logs one line per request.
func AccessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			log.LogAttrs(r.Context(), slog.LevelInfo, "http request",
				slog.String("request_id", RequestIDFrom(r.Context())),
				slog.String("method", r.Method),
				slog.String("path", RedactPath(r.URL.Path)),
				slog.Int("status", ww.Status()),
				slog.Int("bytes", ww.BytesWritten()),
				slog.Duration("duration", time.Since(start)),
			)
		})
	}
}

// secretPathPrefixes are routes whose next path segment is a bearer secret
// (webhook addresses, invite and guest-link tokens).
var secretPathPrefixes = []string{
	"/api/hooks/",
	"/api/workflow-hooks/",
	"/api/invites/",
	"/api/guest-links/",
}

// RedactPath hides secrets carried in paths: the token segment is replaced,
// the rest of the path (e.g. /accept, /join) is kept. The access log and the
// traces record paths through it.
func RedactPath(path string) string {
	for _, prefix := range secretPathPrefixes {
		rest, ok := strings.CutPrefix(path, prefix)
		if !ok {
			continue
		}
		if i := strings.IndexByte(rest, '/'); i >= 0 && prefix != "/api/hooks/" {
			return prefix + "[redacted]" + rest[i:]
		}
		return prefix + "[redacted]"
	}
	return path
}

// SecurityHeaders sets conservative headers on every API response.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		// Other sites cannot embed the API's responses (images, scripts, no-cors fetches).
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}
