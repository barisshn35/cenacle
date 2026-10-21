// SPDX-License-Identifier: Apache-2.0

package signing

import (
	"testing"
	"time"
)

func TestSignAndVerify(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"text":"hi"}`)
	h := Sign("s3cret", now, body)
	if !Verify("s3cret", h, body, now.Add(time.Minute), 5*time.Minute) {
		t.Fatal("valid signature rejected")
	}
	for name, ok := range map[string]bool{
		"other secret": Verify("other", h, body, now, 5*time.Minute),
		"other body":   Verify("s3cret", h, []byte(`{}`), now, 5*time.Minute),
		"too old":      Verify("s3cret", h, body, now.Add(10*time.Minute), 5*time.Minute),
		"garbage":      Verify("s3cret", "nope", body, now, 5*time.Minute),
	} {
		if ok {
			t.Errorf("%s accepted", name)
		}
	}
}
