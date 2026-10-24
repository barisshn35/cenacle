// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"time"
)

// Discord has no export of a server. The importer reads the JSON files of
// DiscordChatExporter (one file per channel, "Export format: JSON"), in a
// directory or archive. Discord does not give out e-mail addresses: people
// come in without one: they keep their names and messages but cannot sign in.

type discordExport struct {
	Guild struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"guild"`
	Channel struct {
		ID       string `json:"id"`
		Type     string `json:"type"`
		Category string `json:"category"`
		Name     string `json:"name"`
		Topic    string `json:"topic"`
	} `json:"channel"`
	Messages []struct {
		ID        string        `json:"id"`
		Type      string        `json:"type"`
		Timestamp time.Time     `json:"timestamp"`
		Content   string        `json:"content"`
		Author    discordUser   `json:"author"`
		Mentions  []discordUser `json:"mentions"`
		// Attachments and embeds are linked, not copied.
		Attachments []struct {
			URL      string `json:"url"`
			FileName string `json:"fileName"`
		} `json:"attachments"`
	} `json:"messages"`
}

type discordUser struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Nickname string `json:"nickname"`
	IsBot    bool   `json:"isBot"`
}

// ReadDiscord reads DiscordChatExporter JSON files. Each Discord server
// becomes a workspace (named after it unless workspace is given); direct
// messages go to workspace, or to the first server.
func ReadDiscord(fsys fs.FS, workspace string) (Data, error) {
	d := Data{Source: "discord"}
	files, err := jsonFiles(fsys, ".")
	if err != nil {
		return d, err
	}
	seen := map[string]bool{}
	addUser := func(u discordUser) {
		if u.ID == "" || seen[u.ID] {
			return
		}
		seen[u.ID] = true
		d.Users = append(d.Users, User{Key: u.ID, DisplayName: firstNonEmpty(u.Nickname, u.Name)})
	}
	var direct []discordExport
	first := workspace
	for _, name := range files {
		var e discordExport
		if err := readJSON(fsys, name, &e); err != nil {
			return d, err
		}
		if e.Channel.ID == "" {
			continue // not a channel export
		}
		if strings.HasPrefix(e.Channel.Type, "Direct") {
			direct = append(direct, e)
			continue
		}
		ws := firstNonEmpty(workspace, e.Guild.Name, "Discord")
		if first == "" {
			first = ws
		}
		ch := Channel{Key: e.Channel.ID, Workspace: ws, Name: e.Channel.Name, Topic: e.Channel.Topic}
		d.Channels = append(d.Channels, discordMessages(&d, ch, e, addUser))
	}
	for _, e := range direct {
		ch := Channel{Key: e.Channel.ID, Workspace: firstNonEmpty(first, "Discord"), Private: true, Conversation: true}
		d.Channels = append(d.Channels, discordMessages(&d, ch, e, addUser))
	}
	if len(d.Channels) == 0 {
		return d, fmt.Errorf("no DiscordChatExporter JSON files found")
	}
	// Channel links name the channel once all of them are known.
	names := map[string]string{}
	for _, c := range d.Channels {
		if !c.Conversation {
			names[c.Key] = c.Name
		}
	}
	for i := range d.Messages {
		d.Messages[i].Body = discordChannelRef.ReplaceAllStringFunc(d.Messages[i].Body, func(m string) string {
			id := discordChannelRef.FindStringSubmatch(m)[1]
			return "#" + firstNonEmpty(names[id], id)
		})
	}
	return d, nil
}

// discordMessages adds the messages of one export; everyone who wrote is a
// member of the channel.
func discordMessages(d *Data, ch Channel, e discordExport, addUser func(discordUser)) Channel {
	members := map[string]bool{}
	for _, m := range e.Messages {
		if m.Type != "Default" && m.Type != "Reply" {
			continue
		}
		addUser(m.Author)
		for _, u := range m.Mentions {
			addUser(u)
		}
		if !members[m.Author.ID] {
			members[m.Author.ID] = true
			ch.Members = append(ch.Members, m.Author.ID)
		}
		body := discordToMarkdown(m.Content)
		for _, a := range m.Attachments {
			body += "\n[" + firstNonEmpty(a.FileName, a.URL) + "](" + a.URL + ")"
		}
		d.Messages = append(d.Messages, Message{
			Key: m.ID, Channel: ch.Key, Author: m.Author.ID, Body: strings.TrimSpace(body), At: m.Timestamp.UTC(),
		})
	}
	return ch
}

var (
	discordUserRef    = regexp.MustCompile(`<@!?(\d+)>`)
	discordChannelRef = regexp.MustCompile(`<#(\w+)>`)
	discordEmoji      = regexp.MustCompile(`<a?:(\w+):\d+>`)
	discordTime       = regexp.MustCompile(`<t:(\d+)(?::[tTdDfFR])?>`)
)

// discordToMarkdown keeps Discord's Markdown; mentions become references to
// the people of the export, custom emoji their :name:.
func discordToMarkdown(text string) string {
	text = discordUserRef.ReplaceAllStringFunc(text, func(m string) string {
		return Mention(discordUserRef.FindStringSubmatch(m)[1])
	})
	text = discordEmoji.ReplaceAllString(text, ":$1:")
	text = discordTime.ReplaceAllStringFunc(text, func(m string) string {
		var sec int64
		_, _ = fmt.Sscan(discordTime.FindStringSubmatch(m)[1], &sec)
		return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04 UTC")
	})
	return strings.NewReplacer("@everyone", "@all").Replace(text)
}
