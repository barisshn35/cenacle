// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func (e *env) setWebApp(c *http.Client, in string) (*http.Response, []byte) {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodPut, e.app.URL+"/api/admin/web-app", strings.NewReader(in))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.app.URL)
	res, err := c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func TestWebAppOff(t *testing.T) {
	e := newEnv(t)
	meta := func() bool {
		var m struct {
			WebApp bool `json:"web_app"`
		}
		_, body := e.do(&http.Client{}, http.MethodGet, "/api/meta", nil)
		_ = json.Unmarshal(body, &m)
		return m.WebApp
	}
	if !meta() {
		t.Fatal("the web app is off by default")
	}

	// ayse@example.com is the administrator; someone else may not change it.
	e.signIn(e.client, "/api/auth/login")
	admin := e.sessionCookie(e.client).Value
	other := newClient(t)
	e.idp.Subject, e.idp.Email, e.idp.Name = "sub-2", "mert@example.com", "Mert Kaya"
	e.signIn(other, "/api/auth/login")
	if res, body := e.setWebApp(other, `{"enabled":false}`); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member turned the web app off: %d %s", res.StatusCode, body)
	}
	if res, body := e.setWebApp(e.client, `{}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing enabled = %d %s", res.StatusCode, body)
	}
	if res, body := e.setWebApp(e.client, `{"enabled":false}`); res.StatusCode != http.StatusOK ||
		!strings.Contains(string(body), `"enabled":false`) {
		t.Fatalf("turn off = %d %s", res.StatusCode, body)
	}
	if meta() {
		t.Error("meta still reports the web app on")
	}

	// Browsers are turned away and lose the cookie; bearer tokens keep working.
	res, body := e.do(other, http.MethodGet, "/api/session", nil)
	if res.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "web_app_off") {
		t.Fatalf("browser session = %d %s", res.StatusCode, body)
	}
	if e.sessionCookie(other) != nil {
		t.Error("the session cookie was kept")
	}
	bearer := http.Header{"Authorization": {"Bearer " + admin}}
	if res, body := e.do(&http.Client{}, http.MethodGet, "/api/session", bearer); res.StatusCode != http.StatusOK {
		t.Fatalf("bearer session = %d %s", res.StatusCode, body)
	}
	// New sign-ins in a browser go back to the app with an explanation.
	if got := signinError(t, e.signIn(newClient(t), "/api/auth/login")); got != "web_app_off" {
		t.Errorf("sign-in error = %q", got)
	}

	// CENACLE_WEB_APP decides over the administrators.
	on := true
	e.webApp.Forced = &on
	if !meta() {
		t.Error("CENACLE_WEB_APP=on did not turn the web app on")
	}
	req, _ := http.NewRequest(http.MethodPut, e.app.URL+"/api/admin/web-app", strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Authorization", "Bearer "+admin)
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = r2.Body.Close()
	if r2.StatusCode != http.StatusConflict {
		t.Errorf("change while forced = %d", r2.StatusCode)
	}
}
