// SPDX-License-Identifier: AGPL-3.0-only

package meetings

import (
	"strings"
	"testing"
	"time"
)

func TestCalendar(t *testing.T) {
	berlin, _ := time.LoadLocation("Europe/Berlin")
	start := time.Date(2026, 10, 20, 14, 0, 0, 0, berlin)
	out := string(Calendar("REQUEST", []Event{{
		UID: "m1@chat.test", Title: "Review; plans, ideas", Description: "Line one\nLine two " + strings.Repeat("ğ", 60),
		Start: start, End: start.Add(45 * time.Minute), TimeZone: "Europe/Berlin",
		Rule: "FREQ=WEEKLY;COUNT=4", Exdates: []time.Time{start.AddDate(0, 0, 7)}, Sequence: 2,
		Organizer: &Person{Name: `Ayşe "A" Demir`, Email: "noreply@chat.test"},
		Attendees: []Person{{Name: "Mert", Email: "mert@example.com"}},
	}}, time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)))
	for _, want := range []string{
		"METHOD:REQUEST\r\n", "TZID:Europe/Berlin\r\n", "BEGIN:DAYLIGHT\r\n", "BEGIN:STANDARD\r\n",
		// The October 2026 change: 03:00 summer time back to 02:00.
		"DTSTART:20261025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\n",
		"DTSTART;TZID=Europe/Berlin:20261020T140000\r\n", "DTEND;TZID=Europe/Berlin:20261020T144500\r\n",
		"RRULE:FREQ=WEEKLY;COUNT=4\r\n", "EXDATE;TZID=Europe/Berlin:20261027T140000\r\n",
		"SEQUENCE:2\r\n", `SUMMARY:Review\; plans\, ideas` + "\r\n", `ORGANIZER;CN="Ayşe A Demir":mailto:noreply@chat.test`,
		"RSVP=FALSE:mailto:mert@example.com", "DTSTAMP:20261112T100000Z\r\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	for _, l := range strings.Split(out, "\r\n") {
		if len(l) > 75 {
			t.Errorf("line longer than 75 octets: %q", l)
		}
	}
	if !strings.Contains(strings.ReplaceAll(out, "\r\n ", ""), `DESCRIPTION:Line one\nLine two ğğ`) {
		t.Error("description not folded back whole")
	}
	// A zone without changes (Istanbul) gets one fixed offset.
	ist, _ := time.LoadLocation("Europe/Istanbul")
	s := time.Date(2026, 11, 17, 14, 0, 0, 0, ist)
	out = string(Calendar("CANCEL", []Event{{UID: "m2", Title: "x", Start: s, End: s.Add(time.Hour), TimeZone: "Europe/Istanbul", Cancelled: true}}, s))
	if !strings.Contains(out, "TZOFFSETFROM:+0300\r\nTZOFFSETTO:+0300") || !strings.Contains(out, "STATUS:CANCELLED") {
		t.Errorf("istanbul/cancel:\n%s", out)
	}
}
