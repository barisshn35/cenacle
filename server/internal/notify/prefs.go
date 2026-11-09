// SPDX-License-Identifier: AGPL-3.0-only

// Package notify decides who is told about a message and tells them: the
// rules of people's notification settings (shared with the web app, which
// applies the same ones to sounds and desktop notifications), e-mail about
// what they missed, and web push.
package notify

import (
	"encoding/json"
	"regexp"
	"strconv"
	"time"
)

// Prefs are a person's notification settings (the JSON of notification_prefs
// and of the API's NotificationPrefs).
type Prefs struct {
	Desktop bool `json:"desktop"`
	Push    bool `json:"push"`
	Sounds  struct {
		Mention string `json:"mention"`
		Direct  string `json:"direct"`
		Message string `json:"message"`
	} `json:"sounds"`
	Volume       int    `json:"volume"`
	DefaultLevel string `json:"default_level"`
	Email        struct {
		Enabled      bool `json:"enabled"`
		DelayMinutes int  `json:"delay_minutes"`
	} `json:"email"`
	PausedUntil *time.Time `json:"paused_until"`
	QuietHours  struct {
		Enabled bool   `json:"enabled"`
		Start   string `json:"start"`
		End     string `json:"end"`
		Days    []int  `json:"days"`
	} `json:"quiet_hours"`
}

// BuiltinSounds are the sounds the app makes itself (no audio files).
var BuiltinSounds = []string{"chime", "bell", "pop", "ding", "marimba", "glass", "drop", "pulse", "harp", "knock",
	"bubble", "twinkle", "whistle", "tap", "blip", "kalimba", "arcade", "breeze", "echo", "gong", "sparkle",
	"notify", "woodblock", "soft"}

// Defaults are the settings until a person changes them.
func Defaults() Prefs {
	var p Prefs
	p.Desktop = true
	p.Sounds.Mention, p.Sounds.Direct, p.Sounds.Message = "chime", "pop", "drop"
	p.Volume = 70
	p.DefaultLevel = "all"
	p.Email.DelayMinutes = 15
	p.QuietHours.Start, p.QuietHours.End = "22:00", "08:00"
	p.QuietHours.Days = []int{0, 1, 2, 3, 4, 5, 6}
	return p
}

var (
	clock   = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
	soundID = regexp.MustCompile(`^(none|user:[0-9a-f-]{36}|[a-z]{2,20})$`)
)

// ValidSound reports whether a sound id is known (built in, none or uploaded).
func ValidSound(s string) bool {
	if !soundID.MatchString(s) {
		return false
	}
	if s == "none" || len(s) > 5 && s[:5] == "user:" {
		return true
	}
	for _, b := range BuiltinSounds {
		if s == b {
			return true
		}
	}
	return false
}

// Valid reports whether the settings are complete and known.
func (p Prefs) Valid() bool {
	if p.Volume < 0 || p.Volume > 100 || !ValidSound(p.Sounds.Mention) || !ValidSound(p.Sounds.Direct) || !ValidSound(p.Sounds.Message) {
		return false
	}
	switch p.DefaultLevel {
	case "all", "mentions", "none":
	default:
		return false
	}
	switch p.Email.DelayMinutes {
	case 5, 15, 60:
	default:
		return false
	}
	if !clock.MatchString(p.QuietHours.Start) || !clock.MatchString(p.QuietHours.End) || len(p.QuietHours.Days) > 7 {
		return false
	}
	for _, d := range p.QuietHours.Days {
		if d < 0 || d > 6 {
			return false
		}
	}
	return true
}

// Read takes stored settings over the defaults (invalid ones read as defaults).
func Read(raw []byte) Prefs { return ReadOver(raw, Defaults()) }

// ReadOver takes stored settings over the given defaults (the installation's).
func ReadOver(raw []byte, p Prefs) Prefs {
	stored := p
	if json.Unmarshal(raw, &stored) == nil && stored.Valid() {
		return stored
	}
	return p
}

// Kind is what a message is to someone.
type Kind int

// Kinds of messages for notifying.
const (
	Message Kind = iota // a message in a channel
	Mention             // a message mentioning them
	Direct              // a message in a conversation (direct or group)
)

// KindOf is the kind of a message for a member of its channel.
func KindOf(channelKind string, mentioned bool) Kind {
	switch {
	case channelKind == "direct" || channelKind == "group":
		return Direct
	case mentioned:
		return Mention
	default:
		return Message
	}
}

// Channel are a person's settings of one channel and its workspace.
type Channel struct {
	Level               string // default, all, mentions, none
	MutedUntil          *time.Time
	WorkspaceMutedUntil *time.Time
}

// Notifies reports whether a message of a kind notifies a person now, with
// their settings, the channel's and their time zone: not while paused, in
// quiet hours or muted; channels by their level (conversations always unless
// set to none).
func Notifies(p Prefs, ch Channel, kind Kind, now time.Time, tz *time.Location) bool {
	if p.PausedUntil != nil && now.Before(*p.PausedUntil) {
		return false
	}
	if ch.MutedUntil != nil && now.Before(*ch.MutedUntil) {
		return false
	}
	if ch.WorkspaceMutedUntil != nil && now.Before(*ch.WorkspaceMutedUntil) {
		return false
	}
	if InQuietHours(p, now, tz) {
		return false
	}
	level := ch.Level
	if level == "" || level == "default" {
		if kind == Direct {
			level = "all"
		} else {
			level = p.DefaultLevel
		}
	}
	switch level {
	case "all":
		return true
	case "mentions":
		return kind == Mention || kind == Direct
	default:
		return false
	}
}

func minutes(hhmm string) int {
	h, _ := strconv.Atoi(hhmm[:2])
	m, _ := strconv.Atoi(hhmm[3:])
	return h*60 + m
}

// InQuietHours reports whether now falls in the quiet hours (local time; a
// window past midnight belongs to the day it starts on).
func InQuietHours(p Prefs, now time.Time, tz *time.Location) bool {
	q := p.QuietHours
	if !q.Enabled || !clock.MatchString(q.Start) || !clock.MatchString(q.End) {
		return false
	}
	if tz == nil {
		tz = time.UTC
	}
	local := now.In(tz)
	at := local.Hour()*60 + local.Minute()
	start, end := minutes(q.Start), minutes(q.End)
	day := int(local.Weekday())
	on := func(d int) bool {
		for _, x := range q.Days {
			if x == d {
				return true
			}
		}
		return false
	}
	if start == end {
		return false
	}
	if start < end {
		return on(day) && at >= start && at < end
	}
	// Past midnight: the evening part on the start day, the morning part on the next.
	return (at >= start && on(day)) || (at < end && on((day+6)%7))
}
