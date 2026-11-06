// SPDX-License-Identifier: AGPL-3.0-only
package config

import (
	"crypto/tls"
	"net"
	"net/url"
	"strconv"
	"strings"
)

type MediaTURN struct {
	Secret, Certificate, PrivateKey string
	MinPort, MaxPort                uint16
	MaxAllocations                  int
}

func turnEnabled(l *loader) bool {
	enabled := l.onOff("CENACLE_MEDIA_TURN")
	return enabled != nil && *enabled
}
func loadMediaTURN(l *loader) *MediaTURN {
	if !turnEnabled(l) {
		return nil
	}
	c := &MediaTURN{Secret: l.str("CENACLE_MEDIA_TURN_SECRET", ""), Certificate: l.str("CENACLE_MEDIA_TURN_TLS_CERT", ""), PrivateKey: l.str("CENACLE_MEDIA_TURN_TLS_KEY", "")}
	if len(c.Secret) < 32 {
		l.fail("CENACLE_MEDIA_TURN_SECRET: at least 32 characters required")
	}
	if _, err := tls.X509KeyPair([]byte(c.Certificate), []byte(c.PrivateKey)); err != nil {
		l.fail("TURN requires a valid TLS certificate and private key")
	}
	minimum, e1 := strconv.Atoi(l.str("CENACLE_MEDIA_TURN_RELAY_MIN", "49152"))
	maximum, e2 := strconv.Atoi(l.str("CENACLE_MEDIA_TURN_RELAY_MAX", "49407"))
	allocations, e3 := strconv.Atoi(l.str("CENACLE_MEDIA_TURN_MAX_ALLOCATIONS", "256"))
	if e1 != nil || e2 != nil || e3 != nil || minimum < 1024 || maximum > 65534 || maximum < minimum || allocations < 1 || allocations > 1024 || maximum-minimum+1 < allocations {
		l.fail("TURN relay range must cover 1 to 1024 allocations within ports 1024 to 65534")
	} else {
		c.MinPort = uint16(minimum) //nolint:gosec // checked above: 1024..65534
		c.MaxPort = uint16(maximum) //nolint:gosec // checked above: 1024..65534
		c.MaxAllocations = allocations
	}
	return c
}
func loadCallTURN(l *loader, c *Calls) {
	if !turnEnabled(l) {
		return
	}
	c.TURNSecret = l.str("CENACLE_MEDIA_TURN_SECRET", "")
	if len(c.TURNSecret) < 32 {
		l.fail("CENACLE_MEDIA_TURN_SECRET: at least 32 characters required")
	}
	origin, err := url.Parse(l.str("CENACLE_PUBLIC_URL", "http://localhost:15173"))
	if err != nil || origin.Hostname() == "" {
		l.fail("TURN requires the installation's public origin")
		return
	}
	host := origin.Hostname()
	raw := l.str("CENACLE_MEDIA_TURN_URLS", "turn:"+net.JoinHostPort(host, "3478")+"?transport=udp,turns:"+net.JoinHostPort(host, "5349")+"?transport=tcp")
	allowedHosts := []string{host, l.str("CENACLE_MEDIA_PUBLIC_IP", "")}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		valid := false
		for _, allowed := range allowedHosts {
			if allowed != "" && (item == "turn:"+net.JoinHostPort(allowed, "3478")+"?transport=udp" || item == "turns:"+net.JoinHostPort(allowed, "5349")+"?transport=tcp") {
				valid = true
			}
		}
		if !valid {
			l.fail("CENACLE_MEDIA_TURN_URLS: only this installation's TURN endpoints are allowed")
		} else {
			c.TURNURLs = append(c.TURNURLs, item)
		}
	}
}
