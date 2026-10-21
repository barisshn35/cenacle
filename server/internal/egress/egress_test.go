// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestBlocksSpecialUseAddresses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	// A loopback test server is blocked by default...
	strict := New(Policy{AllowHTTP: true})
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	if _, err := strict.Do(req); !errors.Is(err, ErrForbiddenAddress) {
		t.Fatalf("loopback reached: %v", err)
	}
	// ...also when a name resolves to it (DNS rebinding).
	strict.resolve = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	port := srv.URL[strings.LastIndex(srv.URL, ":"):]
	req, _ = http.NewRequest(http.MethodGet, "http://bots.example.com"+port, nil)
	if _, err := strict.Do(req); !errors.Is(err, ErrForbiddenAddress) {
		t.Fatalf("name resolving to loopback reached: %v", err)
	}

	// Allowed explicitly, it works; redirects are not followed.
	allow, _ := ParseAllow("127.0.0.1, 10.0.5.0/24")
	ok := New(Policy{AllowHTTP: true, Allow: allow})
	req, _ = http.NewRequest(http.MethodGet, srv.URL, nil)
	if res, err := ok.Do(req); err != nil || string(res.Body) != "ok" {
		t.Fatalf("allowed host: %v %v", res, err)
	}
	req, _ = http.NewRequest(http.MethodGet, srv.URL+"/redirect", nil)
	if res, err := ok.Do(req); err != nil || res.Status != http.StatusFound {
		t.Errorf("redirect followed: %v %v", res.Status, err)
	}

	for _, ip := range []string{"10.1.2.3", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"} {
		if strict.policy.allowed(netip.MustParseAddr(ip)) {
			t.Errorf("%s allowed", ip)
		}
	}
	if !strict.policy.allowed(netip.MustParseAddr("93.184.216.34")) {
		t.Error("public address blocked")
	}
}

func TestURLChecks(t *testing.T) {
	c := New(Policy{})
	for _, bad := range []string{"http://example.com", "ftp://example.com", "https://user:pw@example.com", "/relative", "https://"} {
		if _, err := c.CheckURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if _, err := c.CheckURL("https://hooks.example.com/x"); err != nil {
		t.Error(err)
	}
	if _, err := ParseAllow("not-an-ip"); err == nil {
		t.Error("bad allow list accepted")
	}
}

func TestResponseSizeLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 2048)))
	}))
	defer srv.Close()
	allow, _ := ParseAllow("127.0.0.1")
	c := New(Policy{AllowHTTP: true, Allow: allow, MaxResponse: 1024})
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	if _, err := c.Do(req); err == nil {
		t.Error("oversized response accepted")
	}
}
