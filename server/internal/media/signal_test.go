// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"strings"
	"testing"
)

// Operator: go test ./internal/media -run TestSignalEnvelope
func TestSignalEnvelope(t *testing.T) {
	valid := `{"v":1,"type":"ice_restart","request_id":"restart-1","data":{}}`
	if _, err := DecodeSignal([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{`{}`, valid + `{}`, strings.Replace(valid, `"v":1`, `"v":2`, 1), strings.Replace(valid, `"ice_restart"`, `"unexpected"`, 1), strings.Replace(valid, `"data":{}`, `"extra":1,"data":{}`, 1)} {
		if _, err := DecodeSignal([]byte(input)); err == nil {
			t.Error("invalid envelope accepted")
		}
	}
	if _, err := DecodeSignal([]byte(strings.Repeat("x", MaxSignalBytes+1))); err == nil {
		t.Error("oversized frame accepted")
	}
}

func FuzzSignal(f *testing.F) {
	f.Add([]byte(`{"v":1,"type":"ice","request_id":"1","data":{}}`))
	f.Add([]byte(`{"v":1,"type":"authenticate","data":{"token":"invalid"}}`))
	f.Fuzz(func(t *testing.T, b []byte) { _, _ = DecodeSignal(b) })
}
