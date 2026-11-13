// SPDX-License-Identifier: AGPL-3.0-only

package chat

import "testing"

func TestMeetingPlaceNamesTheConversation(t *testing.T) {
	for _, tc := range []struct{ kind, name, title, want string }{
		{"direct", "direct:01a1d22e-02ef-7e63-9959-b1a38551807c:01a1d22e-cbf9-798f-b3e2-121d35725040", "", "Cenacle call (direct conversation)"},
		{"group", "group:01a1d22e-02ef-7e63-9959-b1a38551807c", "", "Cenacle call (group conversation)"},
		{"group", "group:01a1d22e-02ef-7e63-9959-b1a38551807c", "Launch crew", "Cenacle call (Launch crew)"},
		{"standard", "General", "", "Cenacle call in General"},
	} {
		if got := meetingPlace(tc.kind, tc.name, tc.title); got != tc.want {
			t.Errorf("meetingPlace(%q, %q, %q) = %q, want %q", tc.kind, tc.name, tc.title, got, tc.want)
		}
	}
}
