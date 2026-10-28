// SPDX-License-Identifier: AGPL-3.0-only

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

	for _, ip := range []string{"10.1.2.3", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1",
		// IPv6 forms that carry an IPv4 address (NAT64, 6to4, IPv4-compatible).
		"64:ff9b::a00:1", "64:ff9b:1::a00:1", "2002:a00:1::1", "2002:5db8:d822::1", "::a00:1", "::",
		"3fff::1", "5f00::1"} {
		if strict.policy.allowed(netip.MustParseAddr(ip)) {
			t.Errorf("%s allowed", ip)
		}
	}
	// A zone on an IPv6 literal must not hide it from the blocklist.
	for _, ip := range []string{"::1%x", "fe80::1%x", "fd00::1%x", "2606:2800:220:1:248:1893:25c8:1946%eth0"} {
		if strict.policy.allowed(netip.MustParseAddr(ip)) {
			t.Errorf("zoned %s allowed", ip)
		}
	}
	zoned := "http://[::1%251]" + srv.URL[strings.LastIndex(srv.URL, ":"):]
	if _, err := strict.Dial(context.Background(), "tcp", "[::1%1]"+port); !errors.Is(err, ErrForbiddenAddress) {
		t.Errorf("zoned loopback dialled: %v", err)
	}
	req, _ = http.NewRequest(http.MethodGet, zoned, nil)
	if _, err := strict.Do(req); err == nil {
		t.Errorf("zoned loopback URL reached")
	}
	for _, ip := range []string{"93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"} {
		if !strict.policy.allowed(netip.MustParseAddr(ip)) {
			t.Errorf("public address %s blocked", ip)
		}
	}
}

func TestURLChecks(t *testing.T) {
	c := New(Policy{})
	for _, bad := range []string{"http://example.com", "ftp://example.com", "https://user:pw@example.com", "/relative", "https://",
		"https://[::1%25x]/", "https://[fe80::1%25x]/", "https://[fd00::1%25x]/"} {
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
