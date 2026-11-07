// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"testing"
	"time"
)

func TestNotifies(t *testing.T) {
	ist, _ := time.LoadLocation("Europe/Istanbul")
	noon := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC) // Wednesday 12:00 in Istanbul
	p := Defaults()
	cases := []struct {
		name string
		p    func(*Prefs)
		ch   Channel
		kind Kind
		want bool
	}{
		{"mention by default", nil, Channel{}, Mention, true},
		{"plain message by default (all)", nil, Channel{}, Message, true},
		{"conversation by default", nil, Channel{}, Direct, true},
		{"channel set to all", nil, Channel{Level: "all"}, Message, true},
		{"channel set to none", nil, Channel{Level: "none"}, Mention, false},
		{"default mentions only", func(p *Prefs) { p.DefaultLevel = "mentions" }, Channel{}, Message, false},
		{"default mentions only, a mention", func(p *Prefs) { p.DefaultLevel = "mentions" }, Channel{}, Mention, true},
		{"channel muted", nil, Channel{MutedUntil: ptr(noon.Add(time.Hour))}, Mention, false},
		{"mute over", nil, Channel{MutedUntil: ptr(noon.Add(-time.Hour))}, Mention, true},
		{"workspace muted", nil, Channel{WorkspaceMutedUntil: ptr(noon.Add(time.Hour))}, Direct, false},
		{"paused", func(p *Prefs) { p.PausedUntil = ptr(noon.Add(time.Minute)) }, Channel{}, Direct, false},
		{"quiet hours around noon", func(p *Prefs) {
			p.QuietHours.Enabled, p.QuietHours.Start, p.QuietHours.End = true, "11:30", "13:00"
		}, Channel{}, Direct, false},
		{"quiet hours on other days", func(p *Prefs) {
			p.QuietHours.Enabled, p.QuietHours.Start, p.QuietHours.End, p.QuietHours.Days = true, "11:30", "13:00", []int{0, 6}
		}, Channel{}, Direct, true},
	}
	for _, c := range cases {
		pp := p
		if c.p != nil {
			c.p(&pp)
		}
		if got := Notifies(pp, c.ch, c.kind, noon, ist); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestQuietHoursPastMidnight(t *testing.T) {
	p := Defaults()
	p.QuietHours.Enabled = true  // 22:00-08:00
	p.QuietHours.Days = []int{5} // starting on Friday evening
	at := func(day, h int) time.Time { return time.Date(2026, 10, day, h, 0, 0, 0, time.UTC) }
	// 2026-10-23 is a Friday.
	if !InQuietHours(p, at(23, 23), time.UTC) || !InQuietHours(p, at(24, 7), time.UTC) {
		t.Error("Friday night should be quiet")
	}
	if InQuietHours(p, at(24, 23), time.UTC) || InQuietHours(p, at(23, 7), time.UTC) || InQuietHours(p, at(24, 8), time.UTC) {
		t.Error("only the window starting on Friday is quiet")
	}
}

func TestRead(t *testing.T) {
	if p := Read([]byte(`{"volume": 400}`)); p.Volume != 70 {
		t.Errorf("invalid settings read as %+v", p)
	}
	if p := Read([]byte(`not json`)); p.DefaultLevel != "all" || p.Sounds.Message != "drop" {
		t.Errorf("garbage read as %+v", p)
	}
	d := Defaults()
	d.Sounds.Mention = "user:01a15e50-0000-7000-8000-000000000001"
	if !d.Valid() {
		t.Error("an uploaded sound is valid")
	}
	d.Sounds.Mention = "siren"
	if d.Valid() {
		t.Error("an unknown built-in sound is not")
	}
}

func ptr(t time.Time) *time.Time { return &t }
