// SPDX-License-Identifier: AGPL-3.0-only

// Package meetings holds what meetings need on both sides (ADR 0054): their
// repeat rules and their iCalendar form.
package meetings

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

// A meeting repeats by a subset of RFC 5545 RRULE (ADR 0054): FREQ daily,
// weekly or monthly, INTERVAL, BYDAY (weekly) and UNTIL or COUNT.
type Rule struct {
	Freq     string // DAILY, WEEKLY or MONTHLY
	Interval int
	ByDay    []time.Weekday // weekly: the days (none: the start's day)
	Until    time.Time      // zero: by count
	Count    int            // 0: until
}

// Limits of repeating meetings.
const (
	maxRuleSpan        = 2 * 366 * 24 * time.Hour
	maxRuleOccurrences = 400
	maxRuleInterval    = 12
)

var ruleDays = map[string]time.Weekday{"MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday,
	"TH": time.Thursday, "FR": time.Friday, "SA": time.Saturday, "SU": time.Sunday}

var ErrRule = errors.New("unknown repeat rule")

// ParseRule reads a rule ("" does not repeat: a zero rule).
func ParseRule(s string) (Rule, error) {
	var r Rule
	s = strings.TrimPrefix(strings.TrimSpace(s), "RRULE:")
	if s == "" {
		return r, nil
	}
	r.Interval = 1
	for _, part := range strings.Split(s, ";") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			return r, ErrRule
		}
		switch k {
		case "FREQ":
			if v != "DAILY" && v != "WEEKLY" && v != "MONTHLY" {
				return r, ErrRule
			}
			r.Freq = v
		case "INTERVAL":
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > maxRuleInterval {
				return r, ErrRule
			}
			r.Interval = n
		case "BYDAY":
			for _, d := range strings.Split(v, ",") {
				wd, ok := ruleDays[d]
				if !ok || slices.Contains(r.ByDay, wd) {
					return r, ErrRule
				}
				r.ByDay = append(r.ByDay, wd)
			}
		case "UNTIL":
			t, err := time.Parse("20060102T150405Z", v)
			if err != nil {
				return r, ErrRule
			}
			r.Until = t
		case "COUNT":
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > maxRuleOccurrences {
				return r, ErrRule
			}
			r.Count = n
		default:
			return r, ErrRule
		}
	}
	if r.Freq == "" || (r.Until.IsZero() == (r.Count == 0)) || (len(r.ByDay) > 0 && r.Freq != "WEEKLY") {
		return r, ErrRule // a repeat ends, by a date or a count
	}
	return r, nil
}

// String writes the rule back in its usual form.
func (r Rule) String() string {
	if r.Freq == "" {
		return ""
	}
	parts := []string{"FREQ=" + r.Freq}
	if r.Interval > 1 {
		parts = append(parts, "INTERVAL="+strconv.Itoa(r.Interval))
	}
	if len(r.ByDay) > 0 {
		names := make([]string, 0, len(r.ByDay))
		for _, d := range sortedWeek(r.ByDay) {
			for n, wd := range ruleDays {
				if wd == d {
					names = append(names, n)
				}
			}
		}
		parts = append(parts, "BYDAY="+strings.Join(names, ","))
	}
	if r.Count > 0 {
		parts = append(parts, "COUNT="+strconv.Itoa(r.Count))
	} else {
		parts = append(parts, "UNTIL="+r.Until.UTC().Format("20060102T150405Z"))
	}
	return strings.Join(parts, ";")
}

// sortedWeek orders days from Monday (the rule's week start).
func sortedWeek(days []time.Weekday) []time.Weekday {
	out := slices.Clone(days)
	slices.SortFunc(out, func(a, b time.Weekday) int { return (int(a)+6)%7 - (int(b)+6)%7 })
	return out
}

// Occurrences calls fn with each start of a meeting, in order, from
// its first start (in its time zone: the clock time stays across daylight
// saving changes), skipping the cancelled ones; fn returns false to stop.
// A meeting without a rule has one start.
func Occurrences(start time.Time, loc *time.Location, r Rule, exdates []time.Time, fn func(time.Time) bool) {
	skipped := func(t time.Time) bool {
		return slices.ContainsFunc(exdates, func(e time.Time) bool { return e.Equal(t) })
	}
	if r.Freq == "" {
		if !skipped(start) {
			fn(start)
		}
		return
	}
	local := start.In(loc)
	at := func(y int, m time.Month, d int) time.Time {
		return time.Date(y, m, d, local.Hour(), local.Minute(), local.Second(), 0, loc)
	}
	limit := start.Add(maxRuleSpan)
	if !r.Until.IsZero() && r.Until.Before(limit) {
		limit = r.Until
	}
	n := 0
	// emit reports whether to go on.
	emit := func(t time.Time) bool {
		if t.Before(start) {
			return true
		}
		if t.After(limit) || (r.Count > 0 && n >= r.Count) || n >= maxRuleOccurrences {
			return false
		}
		n++ // cancelled occurrences still count (as in RFC 5545)
		if skipped(t) {
			return true
		}
		return fn(t)
	}
	switch r.Freq {
	case "DAILY":
		for i := 0; ; i += r.Interval {
			if !emit(at(local.Year(), local.Month(), local.Day()+i)) {
				return
			}
		}
	case "WEEKLY":
		days := r.ByDay
		if len(days) == 0 {
			days = []time.Weekday{local.Weekday()}
		}
		days = sortedWeek(days)
		// The Monday of the start's week.
		monday := local.Day() - (int(local.Weekday())+6)%7
		for w := 0; ; w += r.Interval {
			for _, d := range days {
				if !emit(at(local.Year(), local.Month(), monday+7*w+(int(d)+6)%7)) {
					return
				}
			}
		}
	case "MONTHLY":
		for i := 0; ; i += r.Interval {
			first := time.Date(local.Year(), local.Month()+time.Month(i), 1, 0, 0, 0, 0, loc)
			if local.Day() > daysIn(first) {
				// Months without that day are skipped (RFC 5545), but not forever.
				if first.After(limit) {
					return
				}
				continue
			}
			if !emit(at(first.Year(), first.Month(), local.Day())) {
				return
			}
		}
	}
}

func daysIn(first time.Time) int { return first.AddDate(0, 1, -1).Day() }

// LastStart is the latest start a meeting can have (for range queries).
func LastStart(start time.Time, loc *time.Location, r Rule) time.Time {
	last := start
	Occurrences(start, loc, r, nil, func(t time.Time) bool { last = t; return true })
	return last
}

// RuleHelp explains a rule's error.
func RuleHelp(err error) string {
	return fmt.Sprintf("%v: use FREQ=DAILY, WEEKLY or MONTHLY with INTERVAL 1 to %d, BYDAY for weekly, and UNTIL or COUNT (up to %d).",
		err, maxRuleInterval, maxRuleOccurrences)
}
