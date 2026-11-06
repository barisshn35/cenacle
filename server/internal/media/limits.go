// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"

	"github.com/pion/ice/v4"
	"github.com/pion/rtcp"
	"github.com/pion/sdp/v3"
)

const MaxRTCPBytes = 1500

func validateCandidate(raw string, loopback bool) error {
	if raw == "" {
		return nil
	}
	if len(raw) > 2048 {
		return errors.New("candidate exceeds limit")
	}
	raw = strings.TrimPrefix(raw, "candidate:")
	candidate, err := ice.UnmarshalCandidate(raw)
	if err != nil {
		return errors.New("invalid candidate")
	}
	address, err := netip.ParseAddr(candidate.Address())
	address = address.Unmap()
	if err != nil || address.IsUnspecified() || address.IsMulticast() || address.IsLinkLocalUnicast() || (!loopback && address.IsLoopback()) || candidate.Port() < 1 || candidate.Port() > 65535 {
		return errors.New("candidate address denied")
	}
	return nil
}

// ValidateSDP bounds parser work before passing the description to Pion. ICE
// checks may reach real peers, but never loopback or link-local metadata hosts.
func ValidateSDP(raw string, loopback bool) error {
	_, _, err := descriptionInfo(raw, loopback)
	return err
}
func descriptionInfo(raw string, loopback bool) (string, []string, error) {
	if len(raw) == 0 || len(raw) > MaxSDPBytes {
		return "", nil, errors.New("SDP exceeds limit")
	}
	description := sdp.SessionDescription{}
	if err := description.Unmarshal([]byte(raw)); err != nil {
		return "", nil, errors.New("invalid SDP")
	}
	if len(description.MediaDescriptions) == 0 || len(description.MediaDescriptions) > maxMediaSections {
		return "", nil, errors.New("media section limit")
	}
	username := ""
	candidates := []string{}
	seen := map[string]bool{}
	for _, attribute := range description.Attributes {
		if attribute.Key == "ice-ufrag" {
			username = attribute.Value
		}
	}
	for _, section := range description.MediaDescriptions {
		if section.MediaName.Media != "audio" && section.MediaName.Media != "video" {
			return "", nil, errors.New("unsupported media section")
		}
		for _, attribute := range section.Attributes {
			if attribute.Key == "ice-ufrag" {
				if username != "" && username != attribute.Value {
					return "", nil, errors.New("unbundled ICE credentials denied")
				}
				username = attribute.Value
			}
			if attribute.Key == "candidate" {
				if !seen[attribute.Value] {
					seen[attribute.Value] = true
					candidates = append(candidates, attribute.Value)
				}
				if len(candidates) > 64 || validateCandidate(attribute.Value, loopback) != nil {
					return "", nil, errors.New("invalid SDP candidate")
				}
			}
		}
	}
	if len(username) < 4 || len(username) > 256 {
		return "", nil, errors.New("invalid ICE username")
	}
	return username, candidates, nil
}
func ParseRTCP(raw []byte) ([]rtcp.Packet, error) {
	if len(raw) == 0 || len(raw) > MaxRTCPBytes {
		return nil, errors.New("RTCP exceeds limit")
	}
	packets, err := rtcp.Unmarshal(raw)
	if err != nil || len(packets) > 16 {
		return nil, errors.New("invalid RTCP")
	}
	return packets, nil
}

type boundedListener struct {
	net.Listener
	mu    sync.Mutex
	count int
	perIP map[string]int
}

func limitListener(listener net.Listener) net.Listener {
	return &boundedListener{Listener: listener, perIP: map[string]int{}}
}
func (l *boundedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
		if err != nil {
			_ = conn.Close()
			continue
		}
		l.mu.Lock()
		if l.count >= 256 || l.perIP[host] >= 64 {
			l.mu.Unlock()
			_ = conn.Close()
			continue
		}
		l.count++
		l.perIP[host]++
		l.mu.Unlock()
		return &countedConn{Conn: conn, release: func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.count--
			l.perIP[host]--
			if l.perIP[host] == 0 {
				delete(l.perIP, host)
			}
		}}, nil
	}
}

type countedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *countedConn) Close() error { err := c.Conn.Close(); c.once.Do(c.release); return err }
