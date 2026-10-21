// SPDX-License-Identifier: Apache-2.0

package importer

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Mattermost's bulk export (mmctl export create; JSONL, one object per line).
type mmLine struct {
	Type string `json:"type"`
	Team *struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
	} `json:"team"`
	Channel *struct {
		Team        string `json:"team"`
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		Type        string `json:"type"`
		Header      string `json:"header"`
		Purpose     string `json:"purpose"`
	} `json:"channel"`
	User *struct {
		Username  string `json:"username"`
		Email     string `json:"email"`
		Nickname  string `json:"nickname"`
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Roles     string `json:"roles"`
		Teams     []struct {
			Name     string `json:"name"`
			Roles    string `json:"roles"`
			Channels []struct {
				Name  string `json:"name"`
				Roles string `json:"roles"`
			} `json:"channels"`
		} `json:"teams"`
	} `json:"user"`
	Post          *mmPost `json:"post"`
	DirectChannel *struct {
		Members []string `json:"members"`
		Header  string   `json:"header"`
	} `json:"direct_channel"`
	DirectPost *struct {
		ChannelMembers []string  `json:"channel_members"`
		User           string    `json:"user"`
		Message        string    `json:"message"`
		CreateAt       int64     `json:"create_at"`
		Replies        []mmReply `json:"replies"`
	} `json:"direct_post"`
}

type mmPost struct {
	Team     string    `json:"team"`
	Channel  string    `json:"channel"`
	User     string    `json:"user"`
	Message  string    `json:"message"`
	CreateAt int64     `json:"create_at"`
	Replies  []mmReply `json:"replies"`
}

type mmReply struct {
	User     string `json:"user"`
	Message  string `json:"message"`
	CreateAt int64  `json:"create_at"`
}

// ReadMattermost reads a bulk export. Teams become workspaces (named after
// their display name), direct and group messages go to the workspace named
// dmWorkspace (default: the first team). Replies follow their post (threads
// come in v0.18).
func ReadMattermost(r io.Reader, dmWorkspace string) (Data, error) {
	d := Data{Source: "mattermost"}
	teams := map[string]string{} // name -> display name
	var teamOrder []string
	channels := map[string]*Channel{}
	var channelOrder []string
	users := map[string]*User{}
	var userOrder []string
	type dm struct {
		members []string
		posts   []Message
	}
	dms := map[string]*dm{}
	var dmOrder []string
	dmKey := func(members []string) string {
		m := append([]string(nil), members...)
		sortStrings(m)
		return "dm:" + strings.Join(m, ",")
	}
	addDM := func(members []string) *dm {
		k := dmKey(members)
		if c, ok := dms[k]; ok {
			return c
		}
		c := &dm{members: members}
		dms[k] = c
		dmOrder = append(dmOrder, k)
		return c
	}
	var posts []Message
	n := 0
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		n++
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var l mmLine
		if err := json.Unmarshal([]byte(line), &l); err != nil {
			return d, fmt.Errorf("line %d: %w", n, err)
		}
		switch {
		case l.Type == "team" && l.Team != nil:
			name := firstNonEmpty(l.Team.DisplayName, l.Team.Name)
			if _, ok := teams[l.Team.Name]; !ok {
				teamOrder = append(teamOrder, l.Team.Name)
			}
			teams[l.Team.Name] = name
		case l.Type == "channel" && l.Channel != nil:
			c := l.Channel
			key := c.Team + "/" + c.Name
			if _, ok := channels[key]; !ok {
				channelOrder = append(channelOrder, key)
			}
			channels[key] = &Channel{
				Key: key, Workspace: c.Team, Name: firstNonEmpty(c.DisplayName, c.Name),
				Topic: firstNonEmpty(c.Purpose, c.Header), Private: c.Type == "P",
			}
		case l.Type == "user" && l.User != nil:
			u := l.User
			name := strings.TrimSpace(u.FirstName + " " + u.LastName)
			if _, ok := users[u.Username]; !ok {
				userOrder = append(userOrder, u.Username)
			}
			users[u.Username] = &User{
				Key: u.Username, Email: u.Email, DisplayName: firstNonEmpty(name, u.Nickname, u.Username),
				Admin: strings.Contains(u.Roles, "system_admin"),
			}
			for _, t := range u.Teams {
				for _, c := range t.Channels {
					key := t.Name + "/" + c.Name
					ch := channels[key]
					if ch == nil {
						ch = &Channel{Key: key, Workspace: t.Name, Name: c.Name}
						channels[key] = ch
						channelOrder = append(channelOrder, key)
					}
					ch.Members = append(ch.Members, u.Username)
					if strings.Contains(c.Roles, "channel_admin") {
						ch.Managers = append(ch.Managers, u.Username)
					}
				}
			}
		case l.Type == "post" && l.Post != nil:
			p := l.Post
			key := p.Team + "/" + p.Channel
			posts = append(posts, mmMessage(key, p.User, p.Message, p.CreateAt, fmt.Sprintf("p%d", n)))
			for i, rep := range p.Replies {
				posts = append(posts, mmMessage(key, rep.User, rep.Message, rep.CreateAt, fmt.Sprintf("p%d.%d", n, i)))
			}
		case l.Type == "direct_channel" && l.DirectChannel != nil:
			addDM(l.DirectChannel.Members)
		case l.Type == "direct_post" && l.DirectPost != nil:
			p := l.DirectPost
			c := addDM(p.ChannelMembers)
			c.posts = append(c.posts, mmMessage(dmKey(p.ChannelMembers), p.User, p.Message, p.CreateAt, fmt.Sprintf("d%d", n)))
			for i, rep := range p.Replies {
				c.posts = append(c.posts, mmMessage(dmKey(p.ChannelMembers), rep.User, rep.Message, rep.CreateAt, fmt.Sprintf("d%d.%d", n, i)))
			}
		}
	}
	if err := sc.Err(); err != nil {
		return d, err
	}
	if dmWorkspace == "" && len(teamOrder) > 0 {
		dmWorkspace = teamOrder[0]
	}
	workspaceName := func(team string) string { return firstNonEmpty(teams[team], team) }
	for _, k := range userOrder {
		d.Users = append(d.Users, *users[k])
	}
	for _, k := range channelOrder {
		c := *channels[k]
		c.Workspace = workspaceName(c.Workspace)
		d.Channels = append(d.Channels, c)
	}
	for _, k := range dmOrder {
		c := dms[k]
		if dmWorkspace == "" {
			continue
		}
		d.Channels = append(d.Channels, Channel{Key: k, Workspace: workspaceName(dmWorkspace), Conversation: true, Members: c.members})
		posts = append(posts, c.posts...)
	}
	d.Messages = posts
	return d, nil
}

var mmMention = regexp.MustCompile(`(^|[\s(])@([a-z0-9][a-z0-9._-]*[a-z0-9])`)

func mmMessage(channel, user, text string, createAt int64, key string) Message {
	body := mmMention.ReplaceAllStringFunc(text, func(m string) string {
		sub := mmMention.FindStringSubmatch(m)
		switch sub[2] {
		case "here", "channel", "all":
			return m
		}
		return sub[1] + Mention(sub[2])
	})
	return Message{Key: key + ":" + strconv.FormatInt(createAt, 10), Channel: channel, Author: user, Body: body,
		At: time.UnixMilli(createAt).UTC()}
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
