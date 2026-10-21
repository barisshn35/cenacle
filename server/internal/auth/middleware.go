// SPDX-License-Identifier: Apache-2.0

package auth

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/barisshn35/cenacle/server/internal/httpx"
)

// Cookies names and writes the auth cookies. Over https the names carry the
// __Host- prefix: the browser then only accepts them as Secure, host-only
// and for the whole site, so a sibling subdomain cannot plant or shadow them.
type Cookies struct {
	Secure bool
}

// NewCookies derives the cookie settings from the public URL of the app.
func NewCookies(publicURL *url.URL) Cookies {
	return Cookies{Secure: publicURL.Scheme == "https"}
}

// SessionName is the name of the session cookie.
func (c Cookies) SessionName() string {
	if c.Secure {
		return "__Host-cenacle_session"
	}
	return "cenacle_session"
}

func (c Cookies) flowName() string {
	if c.Secure {
		return "__Host-cenacle_signin"
	}
	return "cenacle_signin"
}

func (c Cookies) set(w http.ResponseWriter, name, value string, maxAge int) {
	// Secure is false only when the app itself is served over plain http (local development).
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // see above
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		Secure:   c.Secure,
		HttpOnly: true,
		// Lax: sent on the top-level redirect back from Cenacle ID, never on
		// cross-site subrequests or form posts.
		SameSite: http.SameSiteLaxMode,
	})
}

func (c Cookies) setSession(w http.ResponseWriter, token string, expires time.Time) {
	c.set(w, c.SessionName(), token, int(time.Until(expires)/time.Second))
}

func (c Cookies) clearSession(w http.ResponseWriter) { c.set(w, c.SessionName(), "", -1) }

func (c Cookies) setFlow(w http.ResponseWriter, state string, ttl time.Duration) {
	c.set(w, c.flowName(), state, int(ttl/time.Second))
}

func (c Cookies) clearFlow(w http.ResponseWriter) { c.set(w, c.flowName(), "", -1) }

func (c Cookies) flow(r *http.Request) string {
	if ck, err := r.Cookie(c.flowName()); err == nil {
		return ck.Value
	}
	return ""
}

type principalKey struct{}

// PrincipalFrom returns the authenticated session of the request, if any.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// WithPrincipal returns ctx carrying p (for tests and internal callers).
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// credentials returns the session token of a request and whether it came
// from the cookie. A bearer token takes precedence.
func credentials(r *http.Request, c Cookies) (token string, fromCookie bool) {
	if h := r.Header.Get("Authorization"); h != "" {
		scheme, value, ok := strings.Cut(h, " ")
		if ok && strings.EqualFold(scheme, "Bearer") {
			return strings.TrimSpace(value), false
		}
		return "", false
	}
	if ck, err := r.Cookie(c.SessionName()); err == nil {
		return ck.Value, true
	}
	return "", false
}

// Authenticate attaches the session of the request, if valid, to its
// context. It never rejects a request for a missing or expired session:
// handlers decide whether they need one.
func Authenticate(s *Sessions, c Cookies, trustProxy bool, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, _ := credentials(r, c)
			if token == "" {
				next.ServeHTTP(w, r)
				return
			}
			p, err := s.Authenticate(r.Context(), token,
				ClientInfo{UserAgent: r.UserAgent(), IP: ClientIP(r, trustProxy)})
			switch {
			case err == nil:
				r = r.WithContext(WithPrincipal(r.Context(), p))
			case errors.Is(err, ErrNoSession):
			default:
				log.ErrorContext(r.Context(), "authenticate session", "error", err,
					"request_id", httpx.RequestIDFrom(r.Context()))
				httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: httpx.CodeUnavailable})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func unauthenticated(w http.ResponseWriter, r *http.Request, c Cookies) {
	if _, fromCookie := credentials(r, c); fromCookie {
		c.clearSession(w) // expired or revoked: drop it
	}
	w.Header().Set("WWW-Authenticate", `Bearer realm="cenacle"`)
	httpx.WriteProblem(w, r, httpx.Problem{
		Status: http.StatusUnauthorized,
		Code:   httpx.CodeUnauthenticated,
		Detail: "Sign in to continue.",
	})
}

// SameOrigin rejects state-changing requests that carry the session cookie
// but do not come from the app itself (CSRF defense in depth on top of
// SameSite=Lax). Requests with a bearer token are not exposed to CSRF and pass.
func SameOrigin(publicURL *url.URL, c Cookies) func(http.Handler) http.Handler {
	origin := publicURL.Scheme + "://" + publicURL.Host
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet, http.MethodHead, http.MethodOptions:
				next.ServeHTTP(w, r)
				return
			}
			if r.Header.Get("Authorization") != "" {
				next.ServeHTTP(w, r)
				return
			}
			allowed := false
			if o := r.Header.Get("Origin"); o != "" {
				allowed = o == origin
			} else {
				allowed = r.Header.Get("Sec-Fetch-Site") == "same-origin"
			}
			if !allowed {
				httpx.WriteProblem(w, r, httpx.Problem{
					Status: http.StatusForbidden,
					Code:   httpx.CodeCrossSite,
					Detail: "The request did not come from the Cenacle app.",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ClientIP returns the address of the client. Behind the reverse proxy
// (trustProxy) it is the last X-Forwarded-For entry, the one the proxy added;
// earlier entries are client-controlled.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
			parts := strings.Split(xff[len(xff)-1], ",")
			if ip := net.ParseIP(strings.TrimSpace(parts[len(parts)-1])); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
