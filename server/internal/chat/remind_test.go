// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"testing"
	"time"
)

func TestParseReminder(t *testing.T) {
	ist, _ := time.LoadLocation("Europe/Istanbul")
	now := time.Date(2026, 10, 22, 14, 0, 0, 0, ist)
	cases := []struct {
		in   string
		when time.Time
		text string
	}{
		{"me in 10m check the deploy", now.Add(10 * time.Minute), "check the deploy"},
		{"in 2 hours to call Mert", now.Add(2 * time.Hour), "call Mert"},
		{"me in 3 days renew the certificate", now.AddDate(0, 0, 3), "renew the certificate"},
		{"10 dk sonra toplantı", now.Add(10 * time.Minute), "toplantı"},
		{"2 saat sonra rapor", now.Add(2 * time.Hour), "rapor"},
		{"at 15:30 standup", time.Date(2026, 10, 22, 15, 30, 0, 0, ist), "standup"},
		{"me at 9:00 yoga", time.Date(2026, 10, 23, 9, 0, 0, 0, ist), "yoga"}, // past today: tomorrow
		{"15.30'da kahve", time.Date(2026, 10, 22, 15, 30, 0, 0, ist), "kahve"},
		{"tomorrow plan the sprint", time.Date(2026, 10, 23, 9, 0, 0, 0, ist), "plan the sprint"},
		{"yarın 10:15 bütçe", time.Date(2026, 10, 23, 10, 15, 0, 0, ist), "bütçe"},
	}
	for _, c := range cases {
		when, text, ok := parseReminder(c.in, now, ist)
		if !ok || !when.Equal(c.when) || text != c.text {
			t.Errorf("%q = %v %q %v, want %v %q", c.in, when, text, ok, c.when, c.text)
		}
	}
	for _, bad := range []string{"", "me", "in 10m", "at 25:00 x", "whenever pay rent", "in 9999 days x"} {
		if _, _, ok := parseReminder(bad, now, ist); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}
