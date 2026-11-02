// SPDX-License-Identifier: AGPL-3.0-only

package httpx

import "testing"

func TestLoggedPathHidesWebhookSecrets(t *testing.T) {
	if got := RedactPath("/api/hooks/cnh_secret"); got != "/api/hooks/[redacted]" {
		t.Errorf("hook path logged as %q", got)
	}
	for path, want := range map[string]string{
		"/api/hooks/cnh_secret/slack":          "/api/hooks/[redacted]",
		"/api/workflow-hooks/cnw_secret":       "/api/workflow-hooks/[redacted]",
		"/api/invites/inv_secret":              "/api/invites/[redacted]",
		"/api/invites/inv_secret/accept":       "/api/invites/[redacted]/accept",
		"/api/guest-links/gl_secret":           "/api/guest-links/[redacted]",
		"/api/guest-links/gl_secret/join":      "/api/guest-links/[redacted]/join",
		"/api/workspaces/ws1/invites/inv_id":   "/api/workspaces/ws1/invites/inv_id",
		"/api/channels/c1/guest-links/link_id": "/api/channels/c1/guest-links/link_id",
	} {
		if got := RedactPath(path); got != want {
			t.Errorf("%s logged as %q, want %q", path, got, want)
		}
	}
	if got := RedactPath("/api/channels"); got != "/api/channels" {
		t.Errorf("path logged as %q", got)
	}
}
