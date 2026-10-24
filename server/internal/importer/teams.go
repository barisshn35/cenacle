// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Microsoft Teams has no export file. The importer reads messages saved from
// Microsoft Graph (chatMessage objects, as the API returns them), laid out as:
//
//	users.json                       GET /users (optional: names, e-mail)
//	teams/<team>/<channel>.json      GET /teams/{id}/channels/{id}/messages?$expand=replies
//	chats/<chat>.json                GET /chats/{id}/messages
//
// Each file holds an array or a Graph page ({"value": [...]}). Teams become
// workspaces; chats go to the workspace given, or to the first team.

type graphUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Mail        string `json:"mail"`
	UPN         string `json:"userPrincipalName"`
}

type graphIdentity struct {
	User *struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
	} `json:"user"`
}

type graphMessage struct {
	ID          string         `json:"id"`
	MessageType string         `json:"messageType"`
	Created     time.Time      `json:"createdDateTime"`
	Deleted     *time.Time     `json:"deletedDateTime"`
	From        *graphIdentity `json:"from"`
	Subject     string         `json:"subject"`
	Body        struct {
		ContentType string `json:"contentType"`
		Content     string `json:"content"`
	} `json:"body"`
	Mentions []struct {
		ID        int           `json:"id"`
		Mentioned graphIdentity `json:"mentioned"`
	} `json:"mentions"`
	Replies []graphMessage `json:"replies"`
}

// readGraph reads an array or a Graph page of v.
func readGraph[T any](fsys fs.FS, name string) ([]T, error) {
	var raw json.RawMessage
	if err := readJSON(fsys, name, &raw); err != nil {
		return nil, err
	}
	var list []T
	if len(raw) > 0 && raw[0] == '[' {
		err := json.Unmarshal(raw, &list)
		return list, err
	}
	var page struct {
		Value []T `json:"value"`
	}
	err := json.Unmarshal(raw, &page)
	return page.Value, err
}

// ReadTeams reads messages saved from Microsoft Graph.
func ReadTeams(fsys fs.FS, workspace string) (Data, error) {
	d := Data{Source: "teams"}
	users := map[string]int{} // id → index in d.Users
	addUser := func(id, name string) {
		if id == "" {
			return
		}
		if i, ok := users[id]; ok {
			if d.Users[i].DisplayName == "" {
				d.Users[i].DisplayName = name
			}
			return
		}
		users[id] = len(d.Users)
		d.Users = append(d.Users, User{Key: id, DisplayName: name})
	}
	if p, err := findFile(fsys, "users.json"); err == nil {
		list, err := readGraph[graphUser](fsys, p)
		if err != nil {
			return d, err
		}
		for _, u := range list {
			addUser(u.ID, u.DisplayName)
			d.Users[users[u.ID]].Email = firstNonEmpty(u.Mail, u.UPN)
		}
	}
	files, err := jsonFiles(fsys, ".")
	if err != nil {
		return d, err
	}
	first := workspace
	var chats []string
	for _, name := range files {
		parts := strings.Split(name, "/")
		for len(parts) > 0 && parts[0] != "teams" && parts[0] != "chats" {
			parts = parts[1:] // the export may be wrapped in a top directory
		}
		switch {
		case len(parts) == 3 && parts[0] == "teams":
			ws := firstNonEmpty(workspace, parts[1])
			if first == "" {
				first = ws
			}
			ch := Channel{Key: name, Workspace: ws, Name: strings.TrimSuffix(parts[2], path.Ext(parts[2]))}
			if err := teamsMessages(&d, &ch, fsys, name, addUser); err != nil {
				return d, err
			}
			d.Channels = append(d.Channels, ch)
		case len(parts) == 2 && parts[0] == "chats":
			chats = append(chats, name)
		}
	}
	for _, name := range chats {
		ch := Channel{Key: name, Workspace: firstNonEmpty(first, "Teams"), Private: true, Conversation: true}
		if err := teamsMessages(&d, &ch, fsys, name, addUser); err != nil {
			return d, err
		}
		d.Channels = append(d.Channels, ch)
	}
	if len(d.Channels) == 0 {
		return d, fmt.Errorf("no teams/<team>/<channel>.json or chats/<chat>.json files found")
	}
	return d, nil
}

func teamsMessages(d *Data, ch *Channel, fsys fs.FS, name string, addUser func(id, name string)) error {
	list, err := readGraph[graphMessage](fsys, name)
	if err != nil {
		return err
	}
	members := map[string]bool{}
	var add func(m graphMessage)
	add = func(m graphMessage) {
		for _, r := range m.Replies {
			add(r)
		}
		if m.MessageType != "message" || m.Deleted != nil || m.From == nil || m.From.User == nil {
			return
		}
		author := m.From.User.ID
		addUser(author, m.From.User.DisplayName)
		if !members[author] {
			members[author] = true
			ch.Members = append(ch.Members, author)
		}
		mentioned := map[int]string{}
		for _, mn := range m.Mentions {
			if mn.Mentioned.User != nil {
				addUser(mn.Mentioned.User.ID, mn.Mentioned.User.DisplayName)
				mentioned[mn.ID] = mn.Mentioned.User.ID
			}
		}
		body := m.Body.Content
		if strings.EqualFold(m.Body.ContentType, "html") {
			body = teamsHTMLToMarkdown(body, mentioned)
		}
		if m.Subject != "" {
			body = "**" + m.Subject + "**\n\n" + body
		}
		d.Messages = append(d.Messages, Message{
			Key: ch.Key + "/" + m.ID, Channel: ch.Key, Author: author, Body: body, At: m.Created.UTC(),
		})
	}
	for _, m := range list {
		add(m)
	}
	return nil
}

var (
	teamsAt     = regexp.MustCompile(`(?s)<at id="(\d+)"[^>]*>.*?</at>`)
	teamsLink   = regexp.MustCompile(`(?s)<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	teamsBreak  = regexp.MustCompile(`(?i)<br\s*/?>`)
	teamsBlock  = regexp.MustCompile(`(?i)</(p|div|li|h[1-6])>`)
	teamsBold   = regexp.MustCompile(`(?is)<(b|strong)>(.*?)</(b|strong)>`)
	teamsItalic = regexp.MustCompile(`(?is)<(i|em)>(.*?)</(i|em)>`)
	teamsPre    = regexp.MustCompile(`(?is)<pre[^>]*>(.*?)</pre>`)
	teamsCode   = regexp.MustCompile(`(?is)<code>(.*?)</code>`)
	teamsTag    = regexp.MustCompile(`(?s)<[^>]+>`)
	teamsBlank  = regexp.MustCompile(`\n{3,}`)
)

// teamsHTMLToMarkdown turns the HTML of a Teams message into Markdown:
// mentions, links, bold, italics, code and line breaks; other markup goes.
func teamsHTMLToMarkdown(s string, mentioned map[int]string) string {
	s = teamsAt.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.Atoi(teamsAt.FindStringSubmatch(m)[1])
		if id, ok := mentioned[n]; ok {
			return Mention(id)
		}
		return teamsTag.ReplaceAllString(m, "")
	})
	s = teamsPre.ReplaceAllStringFunc(s, func(m string) string {
		inner := teamsTag.ReplaceAllString(teamsPre.FindStringSubmatch(m)[1], "")
		return "\n```\n" + strings.ReplaceAll(inner, "<", "&lt;") + "\n```\n"
	})
	s = teamsCode.ReplaceAllString(s, "`$1`")
	s = teamsLink.ReplaceAllString(s, "[$2]($1)")
	s = teamsBold.ReplaceAllString(s, "**$2**")
	s = teamsItalic.ReplaceAllString(s, "_${2}_")
	s = teamsBreak.ReplaceAllString(s, "\n")
	s = teamsBlock.ReplaceAllString(s, "\n\n")
	s = teamsTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	return strings.TrimSpace(teamsBlank.ReplaceAllString(s, "\n\n"))
}
