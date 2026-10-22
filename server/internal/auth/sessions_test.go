// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// backchannel posts a logout token like Cenacle ID does.
func (e *env) backchannel(token string) int {
	e.t.Helper()
	res, err := http.PostForm(e.app.URL+"/api/auth/backchannel-logout", url.Values{"logout_token": {token}})
	if err != nil {
		e.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

func (e *env) signedIn(c *http.Client) bool {
	e.t.Helper()
	res, _ := e.do(c, http.MethodGet, "/api/session", nil)
	return res.StatusCode == http.StatusOK
}

func TestBackchannelLogoutEndsTheSessionsOfThatSignIn(t *testing.T) {
	e := newEnv(t)
	e.idp.SID = "sid-a"
	laptop := newClient(t)
	e.signIn(laptop, "/api/auth/login")
	e.idp.SID = "sid-b"
	phone := newClient(t)
	e.signIn(phone, "/api/auth/login")

	// Invalid tokens are refused and end nothing.
	for name, token := range map[string]string{
		"not a token":  "nope",
		"no event":     e.idp.logoutToken("sub-1", "sid-a", map[string]any{"events": nil}),
		"nonce":        e.idp.logoutToken("sub-1", "sid-a", map[string]any{"nonce": "n"}),
		"other client": e.idp.logoutToken("sub-1", "sid-a", map[string]any{"aud": "someone-else"}),
		"expired":      e.idp.logoutToken("sub-1", "sid-a", map[string]any{"exp": 1}),
		"no jti":       e.idp.logoutToken("sub-1", "sid-a", map[string]any{"jti": nil}),
	} {
		if status := e.backchannel(token); status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, status)
		}
	}
	if !e.signedIn(laptop) || !e.signedIn(phone) {
		t.Fatal("an invalid token ended a session")
	}

	token := e.idp.logoutToken("sub-1", "sid-a", nil)
	if status := e.backchannel(token); status != http.StatusOK {
		t.Fatalf("logout = %d", status)
	}
	if e.signedIn(laptop) || !e.signedIn(phone) {
		t.Error("only the laptop's sign-in should have ended")
	}
	if status := e.backchannel(token); status != http.StatusBadRequest {
		t.Errorf("replayed token = %d", status)
	}
	// Without sid every session of the subject ends.
	if status := e.backchannel(e.idp.logoutToken("sub-1", "", nil)); status != http.StatusOK || e.signedIn(phone) {
		t.Errorf("logout without sid = %d, phone still signed in: %v", status, e.signedIn(phone))
	}
}

type deviceSession struct {
	ID      string `json:"id"`
	Current bool   `json:"current"`
}

func (e *env) listSessions(c *http.Client) []deviceSession {
	e.t.Helper()
	res, body := e.do(c, http.MethodGet, "/api/sessions", nil)
	if res.StatusCode != http.StatusOK {
		e.t.Fatalf("list sessions = %d", res.StatusCode)
	}
	var out struct{ Sessions []deviceSession }
	_ = json.Unmarshal(body, &out)
	return out.Sessions
}

func (e *env) post(c *http.Client, path, body string) *http.Response {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.app.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.app.URL)
	res, err := c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res
}

func TestSessionsCanBeListedAndEnded(t *testing.T) {
	e := newEnv(t)
	devices := make([]*http.Client, 3)
	for i := range devices {
		devices[i] = newClient(t)
		e.signIn(devices[i], "/api/auth/login")
	}
	list := e.listSessions(devices[0])
	if len(list) != 3 {
		t.Fatalf("sessions = %+v", list)
	}
	current := 0
	var other string
	for _, s := range list {
		if s.Current {
			current++
		} else {
			other = s.ID
		}
	}
	if current != 1 {
		t.Errorf("current marks = %d", current)
	}

	// Ending one device.
	if res, _ := e.do(devices[0], http.MethodDelete, "/api/sessions/"+other, http.Header{"Origin": {e.app.URL}}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("end session = %d", res.StatusCode)
	}
	if len(e.listSessions(devices[0])) != 2 {
		t.Error("the session was not ended")
	}
	// Another user's or an unknown session is not found.
	if res, _ := e.do(devices[0], http.MethodDelete, "/api/sessions/"+other, http.Header{"Origin": {e.app.URL}}); res.StatusCode != http.StatusNotFound {
		t.Errorf("ending it again = %d", res.StatusCode)
	}

	// Everywhere else, then everywhere.
	if res := e.post(devices[0], "/api/sessions/end-all", `{"keep_current":true}`); res.StatusCode != http.StatusOK {
		t.Fatalf("end others = %d", res.StatusCode)
	}
	if !e.signedIn(devices[0]) || e.signedIn(devices[1]) || e.signedIn(devices[2]) {
		t.Error("keep_current: only this device stays signed in")
	}
	if res := e.post(devices[0], "/api/sessions/end-all", `{}`); res.StatusCode != http.StatusBadRequest {
		t.Errorf("without keep_current = %d", res.StatusCode)
	}
	if res := e.post(devices[0], "/api/sessions/end-all", `{"keep_current":false}`); res.StatusCode != http.StatusOK {
		t.Fatalf("end all = %d", res.StatusCode)
	}
	if e.signedIn(devices[0]) {
		t.Error("still signed in after ending every session")
	}
}

func TestSessionReportsTheAccountPage(t *testing.T) {
	e := newEnv(t)
	c := newClient(t)
	e.signIn(c, "/api/auth/login")
	_, body := e.do(c, http.MethodGet, "/api/session", nil)
	var s struct {
		AccountURL string `json:"account_url"`
	}
	_ = json.Unmarshal(body, &s)
	want := e.idp.Issuer() + "/account?return_to=" + url.QueryEscape(e.app.URL+"/")
	if s.AccountURL != want {
		t.Errorf("account_url = %q, want %q", s.AccountURL, want)
	}
}
