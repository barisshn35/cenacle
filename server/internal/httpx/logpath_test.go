// SPDX-License-Identifier: AGPL-3.0-only

package httpx

import "testing"

func TestLoggedPathHidesWebhookSecrets(t *testing.T) {
	if got := loggedPath("/api/hooks/cnh_secret"); got != "/api/hooks/[redacted]" {
		t.Errorf("hook path logged as %q", got)
	}
	if got := loggedPath("/api/channels"); got != "/api/channels" {
		t.Errorf("path logged as %q", got)
	}
}
