// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/audit"
	"github.com/barisshn35/cenacle/server/internal/httpx"
)

// CodeWebAppOff answers browsers while the web app is turned off.
const CodeWebAppOff = "web_app_off"

// webAppTTL bounds how long a server instance keeps the setting before it
// reads it again, so a change reaches every instance within seconds.
const webAppTTL = 5 * time.Second

// WebApp decides whether people may use Cenacle in web browsers. The
// administrators turn it on or off; CENACLE_WEB_APP overrides them.
type WebApp struct {
	Store interface {
		GetInstanceSettings(ctx context.Context) (bool, error)
		SetWebApp(ctx context.Context, webApp bool) error
	}
	// Forced is CENACLE_WEB_APP; nil leaves the setting to the administrators.
	Forced *bool

	mu     sync.Mutex
	on     bool
	readAt time.Time
}

// Enabled reports whether the web app is on.
func (wa *WebApp) Enabled(ctx context.Context) (bool, error) {
	if wa == nil {
		return true, nil
	}
	if wa.Forced != nil {
		return *wa.Forced, nil
	}
	wa.mu.Lock()
	defer wa.mu.Unlock()
	if time.Since(wa.readAt) < webAppTTL {
		return wa.on, nil
	}
	on, err := wa.Store.GetInstanceSettings(ctx)
	if err != nil {
		return false, err
	}
	wa.on, wa.readAt = on, time.Now()
	return on, nil
}

func (wa *WebApp) set(ctx context.Context, on bool) error {
	if err := wa.Store.SetWebApp(ctx, on); err != nil {
		return err
	}
	wa.mu.Lock()
	wa.on, wa.readAt = on, time.Now()
	wa.mu.Unlock()
	return nil
}

// WebAppGate turns browsers away while the web app is off: requests signed
// in with the session cookie get 403 web_app_off and lose the cookie. Bearer
// tokens (desktop and mobile apps, bots) are not affected.
func WebAppGate(wa *WebApp, c Cookies) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// The app reads /api/meta to learn that it is off.
			if _, fromCookie := credentials(r, c); !fromCookie || r.URL.Path == "/api/meta" {
				next.ServeHTTP(w, r)
				return
			}
			on, err := wa.Enabled(r.Context())
			if err != nil {
				httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusServiceUnavailable, Code: httpx.CodeUnavailable})
				return
			}
			if !on {
				webAppOff(w, r, c)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func webAppOff(w http.ResponseWriter, r *http.Request, c Cookies) {
	c.clearSession(w)
	httpx.WriteProblem(w, r, httpx.Problem{
		Status: http.StatusForbidden,
		Code:   CodeWebAppOff,
		Detail: "Cenacle is not available in web browsers on this server. Use the desktop or mobile app.",
	})
}

// GetMeta implements api.ServerInterface.
func (h *Handlers) GetMeta(w http.ResponseWriter, r *http.Request) {
	on, err := h.WebApp.Enabled(r.Context())
	if err != nil {
		h.unavailable(w, r, "read the web app setting", err)
		return
	}
	meta := api.Meta{WebApp: on, DesktopMinVersion: h.DesktopMinVersion}
	// The apps follow the notification policy in their own notifications.
	if policy, err := h.Users.GetNotificationPolicy(r.Context()); err == nil {
		contents := api.MetaPushContents(policy.PushContents)
		meta.PushContents = &contents
	}
	httpx.WriteJSON(w, http.StatusOK, meta)
}

func (h *Handlers) webAppSetting(w http.ResponseWriter, r *http.Request) {
	on, err := h.WebApp.Enabled(r.Context())
	if err != nil {
		h.unavailable(w, r, "read the web app setting", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, api.WebAppSetting{Enabled: on, Forced: h.WebApp != nil && h.WebApp.Forced != nil})
}

func (h *Handlers) requireInstanceAdmin(w http.ResponseWriter, r *http.Request) (Principal, bool) {
	p, ok := RequirePrincipal(w, r, h.Cookies)
	if !ok {
		return p, false
	}
	if !p.User.IsAdmin {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: httpx.CodeForbidden,
			Detail: "Only server administrators can change this."})
		return p, false
	}
	if !p.AdminNetwork {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusForbidden, Code: CodeAdminNetwork,
			Detail: "The administration is not available from this network."})
		return p, false
	}
	return p, true
}

// GetWebApp implements api.ServerInterface.
func (h *Handlers) GetWebApp(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireInstanceAdmin(w, r); !ok {
		return
	}
	h.webAppSetting(w, r)
}

// SetWebApp implements api.ServerInterface.
func (h *Handlers) SetWebApp(w http.ResponseWriter, r *http.Request) {
	p, ok := h.requireInstanceAdmin(w, r)
	if !ok {
		return
	}
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || in.Enabled == nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusBadRequest, Code: httpx.CodeBadRequest,
			Detail: "enabled is required."})
		return
	}
	if h.WebApp == nil || h.WebApp.Forced != nil {
		httpx.WriteProblem(w, r, httpx.Problem{Status: http.StatusConflict, Code: "web_app_forced",
			Detail: "CENACLE_WEB_APP sets this on the server; change it there."})
		return
	}
	if err := h.WebApp.set(r.Context(), *in.Enabled); err != nil {
		h.unavailable(w, r, "save the web app setting", err)
		return
	}
	h.Audit.Record(r.Context(), audit.Event{
		Actor: p.User.ID, Action: audit.WebAppChanged, IP: p.IP,
		Detail: map[string]any{"enabled": *in.Enabled},
	})
	h.webAppSetting(w, r)
}
