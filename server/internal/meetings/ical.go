// SPDX-License-Identifier: AGPL-3.0-only

package meetings

import (
	"bytes"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Person is an organizer or attendee in a calendar file.
type Person struct {
	Name  string
	Email string
}

// Event is one meeting (all its occurrences) in a calendar file.
type Event struct {
	UID         string
	Title       string
	Description string
	Location    string
	URL         string
	Start, End  time.Time
	TimeZone    string // IANA
	Rule        string // RRULE value, '' when it does not repeat
	Exdates     []time.Time
	Sequence    int
	Cancelled   bool
	Organizer   *Person
	Attendees   []Person
}

// Calendar writes an iCalendar file (RFC 5545). method is REQUEST, CANCEL or
// ” (a subscription); a VTIMEZONE is written for each zone used, so programs
// that do not know IANA names keep the right clock time.
func Calendar(method string, events []Event, now time.Time) []byte {
	var b bytes.Buffer
	line := func(s string) { fold(&b, s) }
	line("BEGIN:VCALENDAR")
	line("VERSION:2.0")
	line("PRODID:-//Cenacle//Meetings//EN")
	line("CALSCALE:GREGORIAN")
	if method != "" {
		line("METHOD:" + method)
	}
	zones := map[string][2]time.Time{}
	for _, e := range events {
		if e.TimeZone == "" || e.TimeZone == "UTC" {
			continue
		}
		span := zones[e.TimeZone]
		last := e.Start
		if r, err := ParseRule(e.Rule); err == nil {
			last = LastStart(e.Start, Location(e.TimeZone), r)
		}
		if span[0].IsZero() || e.Start.Before(span[0]) {
			span[0] = e.Start
		}
		if last.After(span[1]) {
			span[1] = last
		}
		zones[e.TimeZone] = span
	}
	for name, span := range zones {
		writeZone(line, name, span[0], span[1])
	}
	stamp := now.UTC().Format("20060102T150405Z")
	for _, e := range events {
		loc := Location(e.TimeZone)
		local := func(prop string, t time.Time) string {
			if e.TimeZone == "" || e.TimeZone == "UTC" {
				return prop + ":" + t.UTC().Format("20060102T150405Z")
			}
			return prop + ";TZID=" + e.TimeZone + ":" + t.In(loc).Format("20060102T150405")
		}
		line("BEGIN:VEVENT")
		line("UID:" + e.UID)
		line("DTSTAMP:" + stamp)
		line(fmt.Sprintf("SEQUENCE:%d", e.Sequence))
		line(local("DTSTART", e.Start))
		line(local("DTEND", e.End))
		if e.Rule != "" {
			line("RRULE:" + e.Rule)
			for _, x := range e.Exdates {
				line(local("EXDATE", x))
			}
		}
		line("SUMMARY:" + text(e.Title))
		if e.Description != "" {
			line("DESCRIPTION:" + text(e.Description))
		}
		if e.Location != "" {
			line("LOCATION:" + text(e.Location))
		}
		if e.URL != "" {
			line("URL:" + e.URL)
		}
		if e.Cancelled {
			line("STATUS:CANCELLED")
		} else {
			line("STATUS:CONFIRMED")
		}
		if e.Organizer != nil && e.Organizer.Email != "" {
			line("ORGANIZER;CN=" + param(e.Organizer.Name) + ":mailto:" + e.Organizer.Email)
		}
		// Answers are given in Cenacle (ADR 0054): no reply is asked for.
		for _, a := range e.Attendees {
			line("ATTENDEE;CN=" + param(a.Name) + ";ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:" + a.Email)
		}
		line("END:VEVENT")
	}
	line("END:VCALENDAR")
	return b.Bytes()
}

// Location loads an IANA zone (UTC when unknown).
func Location(name string) *time.Location {
	if l, err := time.LoadLocation(name); err == nil && name != "" {
		return l
	}
	return time.UTC
}

// writeZone writes the offsets of a zone around a span: each change of
// offset from a year before the first start to a year after the last.
func writeZone(line func(string), name string, from, to time.Time) {
	loc := Location(name)
	from, to = from.AddDate(-1, 0, 0), to.AddDate(1, 0, 0)
	_, off := from.In(loc).Zone()
	line("BEGIN:VTIMEZONE")
	line("TZID:" + name)
	type change struct {
		at       time.Time
		from, to int
		dst      bool
	}
	var changes []change
	for t := from; t.Before(to); t = t.Add(24 * time.Hour) {
		next := t.Add(24 * time.Hour)
		_, o := next.In(loc).Zone()
		if o == off {
			continue
		}
		// Narrow down to the second.
		lo, hi := t, next
		for hi.Sub(lo) > time.Second {
			mid := lo.Add(hi.Sub(lo) / 2)
			if _, m := mid.In(loc).Zone(); m == off {
				lo = mid
			} else {
				hi = mid
			}
		}
		changes = append(changes, change{at: hi, from: off, to: o, dst: hi.In(loc).IsDST()})
		off = o
	}
	stamp := func(at time.Time, offset int) string {
		return at.UTC().Add(time.Duration(offset) * time.Second).Format("20060102T150405")
	}
	if len(changes) == 0 {
		line("BEGIN:STANDARD")
		line("DTSTART:19700101T000000")
		line("TZOFFSETFROM:" + offset(off))
		line("TZOFFSETTO:" + offset(off))
		line("END:STANDARD")
	}
	for _, c := range changes {
		kind := "STANDARD"
		if c.dst {
			kind = "DAYLIGHT"
		}
		line("BEGIN:" + kind)
		// The local time just before the change, in the offset it leaves.
		line("DTSTART:" + stamp(c.at, c.from))
		line("TZOFFSETFROM:" + offset(c.from))
		line("TZOFFSETTO:" + offset(c.to))
		line("END:" + kind)
	}
	line("END:VTIMEZONE")
}

func offset(sec int) string {
	sign := "+"
	if sec < 0 {
		sign, sec = "-", -sec
	}
	return fmt.Sprintf("%s%02d%02d", sign, sec/3600, sec%3600/60)
}

// text escapes a TEXT value.
func text(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	r := strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\n", `\n`, "\r", "")
	return r.Replace(s)
}

// param writes a parameter value (quoted; quotes and controls cannot appear).
func param(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '"' || r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return `"` + s + `"`
}

// fold writes a content line folded at 75 octets, never inside a character
// (later lines start with the folding space: one octet less).
func fold(b *bytes.Buffer, s string) {
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		b.WriteString(s[:cut])
		b.WriteString("\r\n ")
		s = s[cut:]
		limit = 74
	}
	b.WriteString(s)
	b.WriteString("\r\n")
}
