// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type slackUser struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	RealName string `json:"real_name"`
	IsAdmin  bool   `json:"is_admin"`
	Profile  struct {
		Email       string `json:"email"`
		RealName    string `json:"real_name"`
		DisplayName string `json:"display_name"`
	} `json:"profile"`
}

type slackChannel struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Members []string `json:"members"`
	Topic   struct {
		Value string `json:"value"`
	} `json:"topic"`
	Purpose struct {
		Value string `json:"value"`
	} `json:"purpose"`
}

type slackMessage struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	User    string `json:"user"`
	BotID   string `json:"bot_id"`
	Text    string `json:"text"`
	TS      string `json:"ts"`
}

// ReadSlack reads a Slack export (.zip) into one workspace.
func ReadSlack(zr *zip.Reader, workspace string) (Data, error) {
	d := Data{Source: "slack"}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	readJSON := func(name string, v any) (bool, error) {
		f, ok := files[name]
		if !ok {
			return false, nil
		}
		rc, err := f.Open()
		if err != nil {
			return true, err
		}
		defer func() { _ = rc.Close() }()
		if err := json.NewDecoder(io.LimitReader(rc, 512<<20)).Decode(v); err != nil {
			return true, fmt.Errorf("%s: %w", name, err)
		}
		return true, nil
	}
	var users []slackUser
	if found, err := readJSON("users.json", &users); err != nil || !found {
		if err == nil {
			err = fmt.Errorf("users.json is missing: is this a Slack export?")
		}
		return d, err
	}
	for _, u := range users {
		d.Users = append(d.Users, User{
			Key: u.ID, Email: u.Profile.Email,
			DisplayName: firstNonEmpty(u.Profile.RealName, u.RealName, u.Profile.DisplayName, u.Name),
			Admin:       u.IsAdmin,
		})
	}
	type source struct {
		dir     string
		channel Channel
	}
	var sources []source
	for _, kind := range []struct {
		file    string
		private bool
		conv    bool
	}{{"channels.json", false, false}, {"groups.json", true, false}, {"dms.json", true, true}, {"mpims.json", true, true}} {
		var list []slackChannel
		if _, err := readJSON(kind.file, &list); err != nil {
			return d, err
		}
		for _, c := range list {
			ch := Channel{
				Key: c.ID, Workspace: workspace, Name: c.Name, Private: kind.private, Conversation: kind.conv,
				Topic: firstNonEmpty(c.Purpose.Value, c.Topic.Value), Members: c.Members,
			}
			dir := c.Name
			if kind.file == "dms.json" {
				dir = c.ID
			}
			sources = append(sources, source{dir: dir, channel: ch})
			d.Channels = append(d.Channels, ch)
		}
	}
	for _, s := range sources {
		var days []string
		for name := range files {
			if path.Dir(name) == s.dir && strings.HasSuffix(name, ".json") {
				days = append(days, name)
			}
		}
		sort.Strings(days)
		for _, day := range days {
			var msgs []slackMessage
			if _, err := readJSON(day, &msgs); err != nil {
				return d, err
			}
			for i, m := range msgs {
				if m.Type != "message" || m.User == "" || skippedSubtypes[m.Subtype] {
					continue
				}
				at, err := slackTime(m.TS)
				if err != nil {
					continue
				}
				d.Messages = append(d.Messages, Message{
					Key:     s.channel.Key + "/" + m.TS + "/" + strconv.Itoa(i),
					Channel: s.channel.Key, Author: m.User, Body: SlackToMarkdown(m.Text), At: at,
				})
			}
		}
	}
	return d, nil
}

// Join and leave notices and the like are not messages people wrote.
var skippedSubtypes = map[string]bool{
	"channel_join": true, "channel_leave": true, "channel_purpose": true, "channel_topic": true,
	"channel_name": true, "channel_archive": true, "channel_unarchive": true, "group_join": true,
	"group_leave": true, "pinned_item": true, "unpinned_item": true, "bot_add": true, "bot_remove": true,
	"tombstone": true,
}

func slackTime(ts string) (time.Time, error) {
	sec, frac, _ := strings.Cut(ts, ".")
	s, err := strconv.ParseInt(sec, 10, 64)
	if err != nil {
		return time.Time{}, err
	}
	var micros int64
	if frac != "" {
		frac = (frac + "000000")[:6]
		micros, _ = strconv.ParseInt(frac, 10, 64)
	}
	return time.Unix(s, micros*1000).UTC(), nil
}

var (
	slackLink    = regexp.MustCompile(`<([^<>|]+)(?:\|([^<>]*))?>`)
	slackBold    = regexp.MustCompile(`(^|[\s(])\*([^*\n]+)\*`)
	slackStrike  = regexp.MustCompile(`(^|[\s(])~([^~\n]+)~`)
	slackSpecial = map[string]string{"!here": "@here", "!channel": "@channel", "!everyone": "@all"}
)

// SlackToMarkdown converts Slack's mrkdwn to Markdown: mentions, links,
// channels, bold and strikethrough; entities are decoded.
func SlackToMarkdown(text string) string {
	text = slackLink.ReplaceAllStringFunc(text, func(m string) string {
		sub := slackLink.FindStringSubmatch(m)
		target, label := sub[1], sub[2]
		switch {
		case strings.HasPrefix(target, "@"):
			return Mention(strings.TrimPrefix(target, "@"))
		case strings.HasPrefix(target, "#"):
			return "#" + firstNonEmpty(label, strings.TrimPrefix(target, "#"))
		case strings.HasPrefix(target, "!"):
			if s, ok := slackSpecial[target]; ok {
				return s
			}
			return firstNonEmpty(label, "")
		case label != "":
			return "[" + label + "](" + target + ")"
		default:
			return target
		}
	})
	text = slackBold.ReplaceAllString(text, "$1**$2**")
	text = slackStrike.ReplaceAllString(text, "$1~~$2~~")
	return html.UnescapeString(text)
}
