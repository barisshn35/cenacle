// SPDX-License-Identifier: Apache-2.0

package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestSafeReturnPath(t *testing.T) {
	for in, want := range map[string]string{
		"/":                     "/",
		"/c/general?x=1#m-2":    "/c/general?x=1#m-2",
		"":                      "/",
		"c/general":             "/",
		"//evil.example":        "/",
		`/\evil.example`:        "/",
		"https://evil.example/": "/",
		"/a\r\nSet-Cookie: x":   "/",
	} {
		if got := SafeReturnPath(in); got != want {
			t.Errorf("SafeReturnPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.5:4321"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.7")
	if got := ClientIP(r, false); got != "10.0.0.5" {
		t.Errorf("without proxy trust = %q", got)
	}
	// Only the entry added by our proxy (the last one) is trusted.
	if got := ClientIP(r, true); got != "198.51.100.7" {
		t.Errorf("behind proxy = %q", got)
	}
	r.Header.Set("X-Forwarded-For", "not-an-ip")
	if got := ClientIP(r, true); got != "10.0.0.5" {
		t.Errorf("malformed header = %q", got)
	}
}

func TestCookieNames(t *testing.T) {
	https := NewCookies(&url.URL{Scheme: "https", Host: "chat.example.com"})
	if https.SessionName() != "__Host-cenacle_session" || !https.Secure {
		t.Errorf("https cookies = %+v %s", https, https.SessionName())
	}
	rec := httptest.NewRecorder()
	https.setFlow(rec, "s", flowTTL)
	ck := rec.Result().Cookies()[0]
	if ck.Name != "__Host-cenacle_signin" || !ck.Secure || ck.Path != "/" || ck.Domain != "" {
		t.Errorf("flow cookie = %+v", ck)
	}
	if NewCookies(&url.URL{Scheme: "http", Host: "localhost:5173"}).SessionName() != "cenacle_session" {
		t.Error("http cookie name")
	}
}

type recordTransport struct{ req *http.Request }

func (t *recordTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.req = r
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: r}, nil
}

func TestBackchannelTransport(t *testing.T) {
	rec := &recordTransport{}
	tr := &BackchannelTransport{
		Public:   &url.URL{Scheme: "https", Host: "id.example.com"},
		Internal: &url.URL{Scheme: "http", Host: "idp:8190"},
		Base:     rec,
	}
	req := httptest.NewRequest(http.MethodPost, "https://id.example.com/token", nil)
	if _, err := tr.RoundTrip(req); err != nil {
		t.Fatal(err)
	}
	got := rec.req
	if got.URL.String() != "http://idp:8190/token" || got.Host != "id.example.com" ||
		got.Header.Get("X-Forwarded-Proto") != "https" {
		t.Errorf("rewritten request: url=%s host=%s headers=%v", got.URL, got.Host, got.Header)
	}
	if req.URL.Host != "id.example.com" {
		t.Error("the original request must not be modified")
	}
	other := httptest.NewRequest(http.MethodGet, "https://elsewhere.example/x", nil)
	_, _ = tr.RoundTrip(other)
	if rec.req.URL.Host != "elsewhere.example" {
		t.Errorf("other hosts pass unchanged, got %s", rec.req.URL)
	}
}
