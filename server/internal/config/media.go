// SPDX-License-Identifier: AGPL-3.0-only
package config

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
)

// Media is loaded independently: the media process needs no database or IdP
// credentials, and must never receive the chat admission private key.
type Media struct {
	HTTPAddr        string
	Origin          string
	NodeID          string
	ValkeyAddr      string
	ValkeyPassword  string
	AdmissionPublic ed25519.PublicKey
	AdmissionKeyID  string
	ControlPrivate  ed25519.PrivateKey
	ControlURL      string
	PublicIP        string
	// Where the media node takes ICE traffic: one UDP port for all calls and
	// a TCP fallback. Users reach these ports (docs/install/calls.md).
	ICEUDPAddr string
	ICETCPAddr string
	TURN       *MediaTURN
}

func LoadMedia(lookup LookupFunc, readFile ReadFileFunc) (Media, error) {
	l := loader{lookup: lookup, readFile: readFile}
	c := Media{HTTPAddr: l.str("CENACLE_MEDIA_HTTP_ADDR", ":7880"), Origin: l.str("CENACLE_PUBLIC_URL", ""), NodeID: l.str("CENACLE_MEDIA_NODE_ID", "media-1"), ValkeyAddr: l.str("CENACLE_VALKEY_ADDR", "127.0.0.1:16379"), ValkeyPassword: l.str("CENACLE_VALKEY_PASSWORD", ""), AdmissionKeyID: l.str("CENACLE_CALLS_KEY_ID", "calls-1")}
	c.ControlPrivate = privateKey(&l, "CENACLE_MEDIA_CONTROL_PRIVATE_KEY")
	c.ControlURL = l.str("CENACLE_MEDIA_CONTROL_URL", "http://127.0.0.1:7883/control")
	c.PublicIP = l.str("CENACLE_MEDIA_PUBLIC_IP", "")
	c.ICEUDPAddr = l.str("CENACLE_MEDIA_ICE_UDP_ADDR", ":7882")
	c.ICETCPAddr = l.str("CENACLE_MEDIA_ICE_TCP_ADDR", ":7881")
	c.TURN = loadMediaTURN(&l)
	publicIP, ipErr := netip.ParseAddr(c.PublicIP)
	publicIP = publicIP.Unmap()
	if ipErr != nil || publicIP.IsUnspecified() || publicIP.IsLoopback() || publicIP.IsMulticast() || publicIP.IsLinkLocalUnicast() {
		l.fail("CENACLE_MEDIA_PUBLIC_IP: a non-loopback unicast address is required")
	} else {
		c.PublicIP = publicIP.String()
	}
	u, controlErr := url.Parse(c.ControlURL)
	if controlErr != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		l.fail("CENACLE_MEDIA_CONTROL_URL: invalid internal HTTP URL")
	}
	if _, _, err := net.SplitHostPort(c.HTTPAddr); err != nil {
		l.fail("CENACLE_MEDIA_HTTP_ADDR: expected host:port")
	}
	for name, addr := range map[string]string{"CENACLE_MEDIA_ICE_UDP_ADDR": c.ICEUDPAddr, "CENACLE_MEDIA_ICE_TCP_ADDR": c.ICETCPAddr} {
		if _, port, err := net.SplitHostPort(addr); err != nil || port == "" || port == "0" {
			l.fail("%s: expected host:port with a fixed port", name)
		}
	}
	if _, _, err := net.SplitHostPort(c.ValkeyAddr); err != nil {
		l.fail("CENACLE_VALKEY_ADDR: expected host:port")
	}
	origin, err := url.Parse(c.Origin)
	if err != nil || origin.Host == "" || (origin.Scheme != "https" && origin.Scheme != "http") || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		l.fail("CENACLE_PUBLIC_URL: an exact http(s) origin is required")
	} else {
		c.Origin = origin.Scheme + "://" + origin.Host
		if origin.Scheme == "http" && origin.Hostname() != "localhost" && origin.Hostname() != "127.0.0.1" && origin.Hostname() != "::1" {
			l.fail("CENACLE_PUBLIC_URL: HTTPS is required except on loopback")
		}
	}
	if c.NodeID == "" || len(c.NodeID) > 64 || strings.ContainsAny(c.NodeID, ":/\\ \t\r\n") {
		l.fail("CENACLE_MEDIA_NODE_ID: invalid node identifier")
	}
	raw := l.str("CENACLE_CALLS_PUBLIC_KEY", "")
	block, rest := pem.Decode([]byte(raw))
	if block == nil || block.Type != "PUBLIC KEY" || strings.TrimSpace(string(rest)) != "" {
		l.fail("CENACLE_CALLS_PUBLIC_KEY: expected one public key PEM")
	} else {
		key, parseErr := x509.ParsePKIXPublicKey(block.Bytes)
		public, ok := key.(ed25519.PublicKey)
		if parseErr != nil || !ok {
			l.fail("CENACLE_CALLS_PUBLIC_KEY: expected Ed25519")
		} else {
			c.AdmissionPublic = public
		}
	}
	if c.AdmissionKeyID == "" || len(c.AdmissionKeyID) > 64 {
		l.fail("CENACLE_CALLS_KEY_ID: required, at most 64 characters")
	}
	if len(l.errs) > 0 {
		return Media{}, fmt.Errorf("invalid media configuration: %w", errors.Join(l.errs...))
	}
	return c, nil
}

// Calls exists only when the installation switch is on. The two signing
// directions deliberately use unrelated keys.
type Calls struct {
	Private                     ed25519.PrivateKey
	ControlPublic               ed25519.PublicKey
	KeyID, NodeID, InternalAddr string
	InternalCIDRs               []netip.Prefix
	TURNSecret                  string
	TURNURLs                    []string
}

func loadCalls(l *loader) *Calls {
	switchValue := l.onOff("CENACLE_CALLS")
	if switchValue == nil || !*switchValue {
		return nil
	}
	c := &Calls{Private: privateKey(l, "CENACLE_CALLS_PRIVATE_KEY"), ControlPublic: publicKey(l, "CENACLE_MEDIA_CONTROL_PUBLIC_KEY"), KeyID: l.str("CENACLE_CALLS_KEY_ID", "calls-1"), NodeID: l.str("CENACLE_MEDIA_NODE_ID", "media-1"), InternalAddr: l.str("CENACLE_CALLS_INTERNAL_ADDR", "127.0.0.1:7883")}
	loadCallTURN(l, c)
	if _, _, err := net.SplitHostPort(c.InternalAddr); err != nil {
		l.fail("CENACLE_CALLS_INTERNAL_ADDR: expected host:port")
	}
	if c.KeyID == "" || len(c.KeyID) > 64 || c.NodeID == "" || len(c.NodeID) > 64 || strings.ContainsAny(c.NodeID, ":/\\ \t\r\n") {
		l.fail("invalid calls key or node identifier")
	}
	for _, raw := range strings.Split(l.str("CENACLE_MEDIA_INTERNAL_CIDRS", "127.0.0.0/8,::1/128"), ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil {
			l.fail("CENACLE_MEDIA_INTERNAL_CIDRS: invalid prefix")
			continue
		}
		if prefix.Bits() == 0 {
			l.fail("CENACLE_MEDIA_INTERNAL_CIDRS: an unrestricted network is forbidden")
			continue
		}
		c.InternalCIDRs = append(c.InternalCIDRs, prefix.Masked())
	}
	if len(c.InternalCIDRs) == 0 {
		l.fail("CENACLE_MEDIA_INTERNAL_CIDRS: at least one internal network required")
	}
	return c
}
func privateKey(l *loader, name string) ed25519.PrivateKey {
	block, rest := pem.Decode([]byte(l.str(name, "")))
	if block == nil || block.Type != "PRIVATE KEY" || strings.TrimSpace(string(rest)) != "" {
		l.fail("%s: expected one PKCS8 private key", name)
		return nil
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	private, ok := key.(ed25519.PrivateKey)
	if err != nil || !ok {
		l.fail("%s: expected Ed25519", name)
		return nil
	}
	return private
}
func publicKey(l *loader, name string) ed25519.PublicKey {
	block, rest := pem.Decode([]byte(l.str(name, "")))
	if block == nil || block.Type != "PUBLIC KEY" || strings.TrimSpace(string(rest)) != "" {
		l.fail("%s: expected one public key", name)
		return nil
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	public, ok := key.(ed25519.PublicKey)
	if err != nil || !ok {
		l.fail("%s: expected Ed25519", name)
		return nil
	}
	return public
}
