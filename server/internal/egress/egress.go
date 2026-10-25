// SPDX-License-Identifier: AGPL-3.0-only

// Package egress makes outgoing HTTP requests on behalf of users and bots
// (slash commands, event subscriptions) without letting them reach the
// server's own network: addresses are checked after DNS resolution and the
// connection goes to the checked address (no DNS rebinding), redirects are
// not followed, and time and response size are bounded.
package egress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// ErrForbiddenAddress: the destination is a private, loopback or otherwise
// special-use address that is not allowed.
var ErrForbiddenAddress = errors.New("egress: destination address is not allowed")

// special-use ranges that outgoing requests may not reach unless allowed.
// IPv6 ranges that embed an IPv4 address (NAT64 64:ff9b::/96 and
// 64:ff9b:1::/48, 6to4 2002::/16, IPv4-compatible ::/96) are blocked whole
// rather than judged by the embedded address: a translator could carry them
// into the server's own IPv4 network.
var blocked = mustPrefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
	"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/96", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23",
	"2001:db8::/32", "2002::/16", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10", "ff00::/8",
)

func mustPrefixes(list ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(list))
	for i, s := range list {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// Policy says which destinations are allowed.
type Policy struct {
	// Allow lists networks that are reachable although special-use (an
	// administrator's internal bot hosts, e.g. 10.0.5.0/24).
	Allow []netip.Prefix
	// AllowHTTP permits plain http:// URLs (otherwise https only).
	AllowHTTP bool
	// Timeout bounds a whole request (default 10 s).
	Timeout time.Duration
	// MaxResponse bounds the body read (default 1 MiB).
	MaxResponse int64
}

func (p Policy) allowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, a := range p.Allow {
		if a.Contains(ip) {
			return true
		}
	}
	for _, b := range blocked {
		if b.Contains(ip) {
			return false
		}
	}
	return true
}

// ParseAllow reads a comma-separated list of networks or addresses.
func ParseAllow(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			addr, err := netip.ParseAddr(part)
			if err != nil {
				return nil, fmt.Errorf("egress allow list: %q: %w", part, err)
			}
			out = append(out, netip.PrefixFrom(addr, addr.BitLen()))
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("egress allow list: %q: %w", part, err)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

// Client sends requests under a policy.
type Client struct {
	policy Policy
	http   *http.Client
	// resolve is replaceable in tests.
	resolve func(ctx context.Context, host string) ([]netip.Addr, error)
}

// New returns a client for a policy.
func New(p Policy) *Client {
	if p.Timeout == 0 {
		p.Timeout = 10 * time.Second
	}
	if p.MaxResponse == 0 {
		p.MaxResponse = 1 << 20
	}
	c := &Client{policy: p}
	c.resolve = func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	transport := &http.Transport{
		Proxy:                 nil, // never through an environment proxy
		DialContext:           c.Dial,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: p.Timeout,
		MaxIdleConns:          20,
		IdleConnTimeout:       30 * time.Second,
	}
	c.http = &http.Client{
		Transport: transport,
		Timeout:   p.Timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse // a redirect could lead anywhere
		},
	}
	return c
}

var dialer = &net.Dialer{Timeout: 5 * time.Second}

// Dial connects to addr (host:port) under the policy: the name is resolved
// once and only allowed addresses are tried (raw TCP, e.g. syslog).
func (c *Client) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	var ips []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		ips = []netip.Addr{ip}
	} else if ips, err = c.resolve(ctx, host); err != nil {
		return nil, err
	}
	lastErr := ErrForbiddenAddress
	for _, ip := range ips {
		if !c.policy.allowed(ip) {
			continue
		}
		// Connect to the address that was checked, not to the name again.
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.Unmap().String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// CheckURL validates a destination URL before it is stored (scheme, host).
func (c *Client) CheckURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil {
		return nil, errors.New("the address must be an absolute http(s) URL without credentials")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !c.policy.AllowHTTP {
			return nil, errors.New("the address must use https")
		}
	default:
		return nil, errors.New("the address must use https")
	}
	return u, nil
}

// Response is what came back, with the body read up to the limit.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// Do sends a request and reads the response body (bounded).
func (c *Client) Do(req *http.Request) (Response, error) {
	if _, err := c.CheckURL(req.URL.String()); err != nil {
		return Response{}, err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return Response{}, err
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(res.Body, c.policy.MaxResponse+1))
	if err != nil {
		return Response{}, err
	}
	if int64(len(body)) > c.policy.MaxResponse {
		return Response{}, errors.New("egress: response is too large")
	}
	return Response{Status: res.StatusCode, Header: res.Header, Body: body}, nil
}
