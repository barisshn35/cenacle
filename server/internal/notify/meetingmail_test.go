// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"strings"
	"testing"
	"time"
)

// A meeting planned in a direct or group conversation names the conversation,
// never the channel's internal name.
func TestMeetingMailNamesTheConversation(t *testing.T) {
	start := time.Date(2026, 12, 4, 7, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		kind, name, lang, want string
	}{
		{"direct", "direct:01a1d22e-02ef-7e63-9959-b1a38551807c:01a1d22e-cbf9-798f-b3e2-121d35725040", "en", "Cenacle call in your direct conversation"},
		{"direct", "direct:01a1d22e-02ef-7e63-9959-b1a38551807c:01a1d22e-cbf9-798f-b3e2-121d35725040", "tr", "Cenacle görüşmesi, özel konuşmanızda"},
		{"group", "", "en", "Cenacle call in a group conversation"},
		{"group", "Launch crew", "en", "Cenacle call in the Launch crew conversation"},
		{"standard", "General", "en", "Cenacle call in General"},
	} {
		mail, err := RenderMeetingMail(MeetingMail{
			Kind: "invite", MeetingID: "01a1d235-744e-7317-986c-d85dce5fe28b", ChannelID: "01a1d230-9fe0-7ea7-b4c6-b31cf60de315",
			Title: "Release review", Organizer: "Deniz Kaya", Workspace: "Cenacle",
			Start: start, End: start.Add(30 * time.Minute), TimeZone: "Europe/Istanbul",
			PlaceKind: tc.kind, PlaceName: tc.name, People: []string{"Deniz Kaya", "Mert Demir"}, PeopleTotal: 2,
			Language: tc.lang, RecipientTZ: "Europe/Istanbul", RecipientName: "Mert Demir", RecipientEmail: "mert@example.com",
			PublicURL: "https://chat.example.com", From: "cenacle@example.com",
		}, start.Add(-48*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		cal := string(mail.Calendar)
		for part, body := range map[string]string{"text": mail.Text, "html": mail.HTML, "calendar": cal} {
			if strings.Contains(body, "direct:") {
				t.Errorf("%s/%s: the %s shows the internal name", tc.kind, tc.lang, part)
			}
		}
		if !strings.Contains(mail.Text, tc.want) {
			t.Errorf("%s/%s: text lacks %q", tc.kind, tc.lang, tc.want)
		}
		if !strings.Contains(strings.ReplaceAll(cal, "\r\n ", ""), "LOCATION:"+strings.ReplaceAll(tc.want, ",", `\,`)) {
			t.Errorf("%s/%s: calendar location is not %q:\n%s", tc.kind, tc.lang, tc.want, cal)
		}
	}
}
