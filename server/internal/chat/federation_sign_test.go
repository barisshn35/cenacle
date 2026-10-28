// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"testing"
	"time"

	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
)

// Outgoing requests carry v1 next to v2, so a server moved back below 0.99.2
// (which checks v1 only) still takes them, whatever the connection requires.
func TestFederationSignKeepsV1(t *testing.T) {
	body := []byte(`{"events":[]}`)
	id, rest, ok := federationSigned(federationSign("0199b0a0-0000-7000-8000-000000000001", "events", "s3cret", body))
	if !ok || id != "0199b0a0-0000-7000-8000-000000000001" {
		t.Fatalf("signed = %q %v", id, ok)
	}
	if !signing.Verify("s3cret", rest, body, time.Now(), federationSkew) {
		t.Error("a server before 0.99.2 cannot verify the request")
	}
	if ok, v2 := federationVerify("s3cret", rest, id, "events", body, true); !ok || !v2 {
		t.Errorf("v2 = %v %v", ok, v2)
	}
}
