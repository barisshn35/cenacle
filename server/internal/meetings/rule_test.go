// SPDX-License-Identifier: AGPL-3.0-only

package meetings

import (
	"testing"
	"time"
)

func starts(t *testing.T, start time.Time, loc *time.Location, rule string, ex []time.Time) []string {
	t.Helper()
	r, err := ParseRule(rule)
	if err != nil {
		t.Fatalf("parse %q: %v", rule, err)
	}
	var out []string
	Occurrences(start, loc, r, ex, func(s time.Time) bool {
		out = append(out, s.In(loc).Format("2006-01-02 Mon 15:04"))
		return len(out) < 50
	})
	return out
}

func TestMeetingRule(t *testing.T) {
	berlin, _ := time.LoadLocation("Europe/Berlin")
	ist, _ := time.LoadLocation("Europe/Istanbul")

	// Weekly on Tuesday and Thursday; 14:00 stays 14:00 across the October change.
	got := starts(t, time.Date(2026, 10, 20, 14, 0, 0, 0, berlin), berlin, "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4", nil)
	want := []string{"2026-10-20 Tue 14:00", "2026-10-22 Thu 14:00", "2026-10-27 Tue 14:00", "2026-10-29 Thu 14:00"}
	if len(got) != 4 || got[0] != want[0] || got[3] != want[3] || got[2] != want[2] {
		t.Fatalf("weekly: %v", got)
	}
	// A start on Wednesday with BYDAY=MO,WE: the Monday before it is not a start.
	got = starts(t, time.Date(2026, 11, 18, 9, 0, 0, 0, ist), ist, "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3", nil)
	if len(got) != 3 || got[0] != "2026-11-18 Wed 09:00" || got[1] != "2026-11-23 Mon 09:00" {
		t.Fatalf("weekly from mid-week: %v", got)
	}
	// Monthly on the 31st skips shorter months.
	got = starts(t, time.Date(2027, 1, 31, 10, 0, 0, 0, ist), ist, "FREQ=MONTHLY;UNTIL=20270801T000000Z", nil)
	if len(got) != 4 || got[1] != "2027-03-31 Wed 10:00" || got[3] != "2027-07-31 Sat 10:00" {
		t.Fatalf("monthly: %v", got)
	}
	// Every second day; a cancelled occurrence is skipped but counted.
	first := time.Date(2026, 11, 17, 14, 0, 0, 0, ist)
	got = starts(t, first, ist, "FREQ=DAILY;INTERVAL=2;COUNT=3", []time.Time{first.AddDate(0, 0, 2)})
	if len(got) != 2 || got[1] != "2026-11-21 Sat 14:00" {
		t.Fatalf("daily: %v", got)
	}
	// Until is inclusive.
	got = starts(t, first, ist, "FREQ=WEEKLY;UNTIL=20261215T110000Z", nil)
	if len(got) != 5 || got[4] != "2026-12-15 Tue 14:00" {
		t.Fatalf("until: %v", got)
	}
	r, _ := ParseRule("FREQ=WEEKLY;UNTIL=20261215T110000Z")
	if last := LastStart(first, ist, r); !last.Equal(time.Date(2026, 12, 15, 14, 0, 0, 0, ist)) {
		t.Fatalf("last start: %v", last)
	}
	if r.String() != "FREQ=WEEKLY;UNTIL=20261215T110000Z" {
		t.Fatalf("string: %s", r.String())
	}
	// Never ending, unknown parts and BYDAY outside weekly are refused.
	for _, bad := range []string{"FREQ=WEEKLY", "FREQ=YEARLY;COUNT=2", "FREQ=DAILY;COUNT=2;BYDAY=MO",
		"FREQ=DAILY;COUNT=2;UNTIL=20270101T000000Z", "FREQ=DAILY;COUNT=500", "FREQ=DAILY;INTERVAL=13;COUNT=2", "FREQ=DAILY;BYHOUR=1;COUNT=2"} {
		if _, err := ParseRule(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	// No rule: one start.
	if got := starts(t, first, ist, "", nil); len(got) != 1 {
		t.Fatalf("single: %v", got)
	}
}
