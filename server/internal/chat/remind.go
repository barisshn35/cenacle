// SPDX-License-Identifier: Apache-2.0

package chat

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Reminders understand a time first, then the text (English or Turkish):
//
//	/remind [me] in 10m|10 min|2 hours|3 days <text>
//	/remind [me] at 15:30 <text>          (today, or tomorrow when past)
//	/remind [me] tomorrow [at 9:00] <text>
//	/remind 10 dk sonra <text> · 2 saat sonra <text> · yarın [9:00] <text> · 15:30'da <text>
var (
	remindIn       = regexp.MustCompile(`^(?i)in\s+(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\b\s*(.*)$`)
	remindInTR     = regexp.MustCompile(`^(?i)(\d{1,4})\s*(dk|dakika|sa|saat|gün|gun)\s+sonra\b\s*(.*)$`)
	remindAt       = regexp.MustCompile(`^(?i)(?:at\s+)?(\d{1,2})[:.](\d{2})(?:'?(?:de|da|te|ta))?\s+(.*)$`)
	remindTomorrow = regexp.MustCompile(`^(?i)(tomorrow|yarın|yarin)(?:\s+(?:at\s+)?(\d{1,2})[:.](\d{2})(?:'?(?:de|da|te|ta))?)?\s+(.*)$`)
)

// MaxReminderAhead bounds how far ahead a reminder can be.
const MaxReminderAhead = 365 * 24 * time.Hour

func unit(u string) time.Duration {
	switch strings.ToLower(u) {
	case "m", "min", "mins", "minute", "minutes", "dk", "dakika":
		return time.Minute
	case "h", "hr", "hour", "hours", "sa", "saat":
		return time.Hour
	default:
		return 24 * time.Hour
	}
}

// parseReminder returns when and what to remind, in the caller's time zone.
func parseReminder(input string, now time.Time, loc *time.Location) (time.Time, string, bool) {
	s := strings.TrimSpace(input)
	if rest, ok := strings.CutPrefix(strings.ToLower(s), "me "); ok {
		s = strings.TrimSpace(s[len(s)-len(rest):])
	}
	now = now.In(loc)
	at := func(day time.Time, hh, mm string) (time.Time, bool) {
		h, _ := strconv.Atoi(hh)
		m, _ := strconv.Atoi(mm)
		if h > 23 || m > 59 {
			return time.Time{}, false
		}
		return time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, loc), true
	}
	var when time.Time
	var text string
	switch {
	case remindIn.MatchString(s), remindInTR.MatchString(s):
		m := remindIn.FindStringSubmatch(s)
		if m == nil {
			m = remindInTR.FindStringSubmatch(s)
		}
		n, _ := strconv.Atoi(m[1])
		when, text = now.Add(time.Duration(n)*unit(m[2])), m[3]
	case remindTomorrow.MatchString(s):
		m := remindTomorrow.FindStringSubmatch(s)
		hh, mm := "9", "00"
		if m[2] != "" {
			hh, mm = m[2], m[3]
		}
		t, ok := at(now.AddDate(0, 0, 1), hh, mm)
		if !ok {
			return time.Time{}, "", false
		}
		when, text = t, m[4]
	case remindAt.MatchString(s):
		m := remindAt.FindStringSubmatch(s)
		t, ok := at(now, m[1], m[2])
		if !ok {
			return time.Time{}, "", false
		}
		if !t.After(now) {
			t = t.AddDate(0, 0, 1)
		}
		when, text = t, m[3]
	default:
		return time.Time{}, "", false
	}
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), "to "))
	if text == "" || !when.After(now) || when.Sub(now) > MaxReminderAhead {
		return time.Time{}, "", false
	}
	return when, text, true
}
