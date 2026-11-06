// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"encoding/binary"
	"errors"
	"io"
	"net/netip"
	"os"
	"strings"
	"testing"
)

// Operator gate: capture the MEDIA NETWORK NAMESPACE, including all interfaces,
// throughout real fixture calls and reconnections. This checks actual packets,
// not source-text matches. Classic PCAP, Ethernet/raw-IP/Linux-SLL only.
func TestCapturedMediaEgress(t *testing.T) {
	path := os.Getenv("CENACLE_MEDIA_PCAP")
	if path == "" {
		t.Skip("operator packet capture required; this is not an egress pass")
	}
	sources := map[netip.Addr]bool{}
	for _, raw := range strings.Split(os.Getenv("CENACLE_MEDIA_CAPTURE_SOURCES"), ",") {
		ip, err := netip.ParseAddr(strings.TrimSpace(raw))
		if err != nil {
			t.Fatal("explicit capture source IPs required")
		}
		sources[ip.Unmap()] = true
	}
	var allowed []netip.Prefix
	for _, raw := range strings.Split(os.Getenv("CENACLE_MEDIA_CAPTURE_ALLOW_CIDRS"), ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || prefix.Bits() == 0 {
			t.Fatal("explicit narrow fixture/infra CIDRs required")
		}
		allowed = append(allowed, prefix)
	}
	names := map[string]bool{}
	for _, raw := range strings.Split(os.Getenv("CENACLE_MEDIA_CAPTURE_DNS_NAMES"), ",") {
		if raw != "" {
			names[strings.ToLower(strings.TrimSuffix(raw, "."))] = true
		}
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || info.Size() > 256<<20 {
		t.Fatal("capture must be at most 256 MiB; rotate captures")
	}
	header := make([]byte, 24)
	if _, err = io.ReadFull(file, header); err != nil {
		t.Fatal("invalid PCAP header")
	}
	var order binary.ByteOrder
	switch string(header[:4]) {
	case "\xd4\xc3\xb2\xa1", "\x4d\x3c\xb2\xa1":
		order = binary.LittleEndian
	case "\xa1\xb2\xc3\xd4", "\xa1\xb2\x3c\x4d":
		order = binary.BigEndian
	default:
		t.Fatal("classic PCAP required, not PCAPNG")
	}
	link := order.Uint32(header[20:24])
	checked := 0
	for {
		record := make([]byte, 16)
		_, err = io.ReadFull(file, record)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal("truncated capture")
		}
		size := order.Uint32(record[8:12])
		original := order.Uint32(record[12:16])
		if size == 0 || size > 65536 || size != original {
			t.Fatal("truncated or oversized captured packet; use full snaplen")
		}
		packet := make([]byte, size)
		if _, err = io.ReadFull(file, packet); err != nil {
			t.Fatal("truncated capture")
		}
		switch link {
		case 1:
			if len(packet) < 14 {
				t.Fatal("short Ethernet frame")
			}
			ether := binary.BigEndian.Uint16(packet[12:14])
			packet = packet[14:]
			if ether == 0x0806 {
				continue
			}
			if ether != 0x0800 && ether != 0x86dd {
				t.Fatal("unsupported EtherType; cannot claim egress coverage")
			}
		case 113:
			if len(packet) < 16 {
				t.Fatal("short SLL frame")
			}
			ether := binary.BigEndian.Uint16(packet[14:16])
			packet = packet[16:]
			if ether == 0x0806 {
				continue
			}
			if ether != 0x0800 && ether != 0x86dd {
				t.Fatal("unsupported SLL protocol")
			}
		case 12, 101:
		default:
			t.Fatal("unsupported capture link type")
		}
		source, dest, proto, payload, parseErr := capturedIP(packet)
		if parseErr != "" {
			t.Fatal(parseErr)
		}
		if !sources[source.Unmap()] {
			continue
		}
		checked++
		permitted := false
		for _, prefix := range allowed {
			if prefix.Contains(dest.Unmap()) {
				permitted = true
				break
			}
		}
		if !permitted {
			t.Fatalf("unexpected outgoing destination %s", dest)
		}
		if proto == 17 {
			if len(payload) < 8 {
				t.Fatal("short UDP packet")
			}
			if binary.BigEndian.Uint16(payload[2:4]) == 53 {
				name, ok := captureDNSName(payload[8:])
				if !ok || !names[name] {
					t.Fatal("unexpected or malformed outgoing DNS query")
				}
			}
		} else if proto == 6 {
			if len(payload) < 20 {
				t.Fatal("short TCP packet")
			}
			if binary.BigEndian.Uint16(payload[2:4]) == 53 {
				t.Fatal("TCP DNS is outside this bounded capture fixture; inspect explicitly")
			}
		} else if proto != 1 && proto != 58 {
			t.Fatal("unsupported outgoing IP protocol")
		}
	}
	if checked < 20 {
		t.Fatal("capture has insufficient outgoing fixture traffic")
	}
}

func capturedIP(packet []byte) (netip.Addr, netip.Addr, byte, []byte, string) {
	if len(packet) < 20 {
		return netip.Addr{}, netip.Addr{}, 0, nil, "short IP packet"
	}
	if packet[0]>>4 == 4 {
		offset := int(packet[0]&15) * 4
		if offset < 20 || offset > len(packet) || binary.BigEndian.Uint16(packet[6:8])&0x3fff != 0 {
			return netip.Addr{}, netip.Addr{}, 0, nil, "fragmented or invalid IPv4; cannot verify"
		}
		source, _ := netip.AddrFromSlice(packet[12:16])
		dest, _ := netip.AddrFromSlice(packet[16:20])
		return source, dest, packet[9], packet[offset:], ""
	}
	if packet[0]>>4 == 6 && len(packet) >= 40 {
		source, _ := netip.AddrFromSlice(packet[8:24])
		dest, _ := netip.AddrFromSlice(packet[24:40])
		next, payload := packet[6], packet[40:]
		// The kernel's MLD reports carry one Hop-by-Hop header (router alert) and go
		// to link-local multicast: they cannot leave the link. Any other extension
		// still needs explicit analysis.
		if next == 0 && len(payload) >= 8 && payload[0] == 58 && dest.IsLinkLocalMulticast() {
			size := (int(payload[1]) + 1) * 8
			if size > len(payload) {
				return source, dest, 0, nil, "short IPv6 Hop-by-Hop header"
			}
			next, payload = 58, payload[size:]
		}
		if next != 6 && next != 17 && next != 58 {
			return source, dest, 0, nil, "IPv6 extensions need explicit analysis; cannot claim coverage"
		}
		return source, dest, next, payload, ""
	}
	return netip.Addr{}, netip.Addr{}, 0, nil, "invalid IP version"
}
func captureDNSName(packet []byte) (string, bool) {
	if len(packet) < 13 || packet[2]&0x80 != 0 || binary.BigEndian.Uint16(packet[4:6]) != 1 {
		return "", false
	}
	offset := 12
	labels := []string{}
	for offset < len(packet) && len(labels) < 32 {
		size := int(packet[offset])
		offset++
		if size == 0 {
			return strings.ToLower(strings.Join(labels, ".")), len(labels) > 0 && offset+4 <= len(packet)
		}
		if size > 63 || offset+size > len(packet) {
			return "", false
		}
		labels = append(labels, string(packet[offset:offset+size]))
		offset += size
	}
	return "", false
}
