// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"strings"
	"testing"
)

// Operator: go test ./internal/media -run TestCandidateTargets
func TestCandidateTargets(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "untrusted.local"} {
		if validateCandidate("1 1 udp 123 "+address+" 7882 typ host", false) == nil {
			t.Errorf("accepted disallowed address %s", address)
		}
	}
	if validateCandidate("1 1 udp 123 192.168.1.25 7882 typ host", false) != nil {
		t.Fatal("private peer address denied")
	}
	if ValidateSDP(strings.Repeat("x", MaxSDPBytes+1), false) == nil {
		t.Fatal("oversized SDP accepted")
	}
	if _, err := ParseRTCP(make([]byte, MaxRTCPBytes+1)); err == nil {
		t.Fatal("oversized RTCP accepted")
	}
}
func FuzzSDP(f *testing.F) {
	f.Add("v=0\r\n")
	f.Fuzz(func(t *testing.T, input string) { _ = ValidateSDP(input, false) })
}
func FuzzRTCP(f *testing.F) {
	f.Add([]byte{0x80, 200, 0, 0})
	f.Fuzz(func(t *testing.T, input []byte) { _, _ = ParseRTCP(input) })
}
