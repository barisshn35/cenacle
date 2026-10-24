// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"fmt"
	"io/fs"
	"math"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Zulip's organization export (manage.py export, or the export in the
// organization settings): a .tar.gz with realm.json and messages-*.json.

type zulipRealm struct {
	Realm []struct {
		Name string `json:"name"`
	} `json:"zerver_realm"`
	Users []zulipUser `json:"zerver_userprofile"`
	// Mirror dummies are people of an imported organization who never joined.
	Dummies []zulipUser `json:"zerver_userprofile_mirrordummy"`
	Streams []struct {
		ID          int    `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		InviteOnly  bool   `json:"invite_only"`
		Deactivated bool   `json:"deactivated"`
	} `json:"zerver_stream"`
	Recipients []struct {
		ID     int `json:"id"`
		Type   int `json:"type"` // 1 a person, 2 a stream, 3 a group
		TypeID int `json:"type_id"`
	} `json:"zerver_recipient"`
	Subscriptions []struct {
		User      int `json:"user_profile"`
		Recipient int `json:"recipient"`
	} `json:"zerver_subscription"`
}

type zulipUser struct {
	ID            int    `json:"id"`
	Email         string `json:"email"`
	DeliveryEmail string `json:"delivery_email"`
	FullName      string `json:"full_name"`
	Role          int    `json:"role"` // 100 owner, 200 administrator
}

type zulipMessages struct {
	Messages []struct {
		ID        int     `json:"id"`
		Sender    int     `json:"sender"`
		Recipient int     `json:"recipient"`
		Content   string  `json:"content"`
		DateSent  float64 `json:"date_sent"`
		Subject   string  `json:"subject"`
	} `json:"zerver_message"`
}

const (
	zulipPersonal = 1
	zulipStream   = 2
	zulipGroup    = 3
)

// ReadZulip reads a Zulip organization export into one workspace (default:
// the organization's name). Topics are kept: a message that starts a new topic
// in a channel begins with the topic in bold.
func ReadZulip(fsys fs.FS, workspace string) (Data, error) {
	d := Data{Source: "zulip"}
	realmFile, err := findFile(fsys, "realm.json")
	if err != nil {
		return d, fmt.Errorf("%w: is this a Zulip export?", err)
	}
	var realm zulipRealm
	if err := readJSON(fsys, realmFile, &realm); err != nil {
		return d, err
	}
	if workspace == "" && len(realm.Realm) > 0 {
		workspace = realm.Realm[0].Name
	}
	if workspace == "" {
		workspace = "Zulip"
	}
	byName := map[string]string{}
	for _, u := range append(realm.Users, realm.Dummies...) {
		key := strconv.Itoa(u.ID)
		d.Users = append(d.Users, User{
			Key: key, Email: firstNonEmpty(u.DeliveryEmail, u.Email),
			DisplayName: u.FullName, Admin: u.Role == 100 || u.Role == 200,
		})
		byName[u.FullName] = key
	}
	subscribers := map[int][]string{}
	for _, s := range realm.Subscriptions {
		subscribers[s.Recipient] = append(subscribers[s.Recipient], strconv.Itoa(s.User))
	}
	type target struct {
		kind, typeID int
	}
	recipients := map[int]target{}
	for _, r := range realm.Recipients {
		recipients[r.ID] = target{r.Type, r.TypeID}
	}
	streamRecipient := map[int]int{}
	groupKey := map[int]string{}
	for id, r := range recipients {
		switch r.kind {
		case zulipStream:
			streamRecipient[r.typeID] = id
		case zulipGroup:
			key := "group-" + strconv.Itoa(id)
			groupKey[id] = key
			d.Channels = append(d.Channels, Channel{
				Key: key, Workspace: workspace, Private: true, Conversation: true, Members: subscribers[id],
			})
		}
	}
	for _, s := range realm.Streams {
		if s.Deactivated {
			continue
		}
		d.Channels = append(d.Channels, Channel{
			Key: "stream-" + strconv.Itoa(s.ID), Workspace: workspace, Name: s.Name,
			Topic: s.Description, Private: s.InviteOnly, Members: subscribers[streamRecipient[s.ID]],
		})
	}
	// Direct messages between two people become one conversation per pair.
	pairs := map[string]bool{}
	pairKey := func(a, b string) string {
		if b < a {
			a, b = b, a
		}
		return "dm-" + a + "-" + b
	}

	files, err := fs.Glob(fsys, path.Join(path.Dir(realmFile), "messages-*.json"))
	if err != nil {
		return d, err
	}
	sort.Strings(files)
	lastTopic := map[string]string{}
	for _, name := range files {
		var part zulipMessages
		if err := readJSON(fsys, name, &part); err != nil {
			return d, err
		}
		sort.Slice(part.Messages, func(i, j int) bool { return part.Messages[i].ID < part.Messages[j].ID })
		for _, m := range part.Messages {
			r, ok := recipients[m.Recipient]
			if !ok {
				continue
			}
			sender := strconv.Itoa(m.Sender)
			var channel string
			switch r.kind {
			case zulipStream:
				channel = "stream-" + strconv.Itoa(r.typeID)
			case zulipGroup:
				channel = groupKey[m.Recipient]
			case zulipPersonal:
				other := strconv.Itoa(r.typeID)
				if other == sender {
					continue
				}
				channel = pairKey(sender, other)
				if !pairs[channel] {
					pairs[channel] = true
					d.Channels = append(d.Channels, Channel{
						Key: channel, Workspace: workspace, Private: true, Conversation: true,
						Members: []string{sender, other},
					})
				}
			default:
				continue
			}
			body := zulipToMarkdown(m.Content, byName)
			if r.kind == zulipStream && m.Subject != "" && lastTopic[channel] != m.Subject {
				lastTopic[channel] = m.Subject
				body = "**" + m.Subject + "**\n\n" + body
			}
			sec, frac := math.Modf(m.DateSent)
			d.Messages = append(d.Messages, Message{
				Key: strconv.Itoa(m.ID), Channel: channel, Author: sender, Body: body,
				At: time.Unix(int64(sec), int64(frac*1e9)).UTC(),
			})
		}
	}
	return d, nil
}

var (
	zulipMention = regexp.MustCompile(`@_?\*\*([^*|]+)(?:\|(\d+))?\*\*`)
	zulipStreamL = regexp.MustCompile(`#\*\*([^*>]+)(?:>[^*]*)?\*\*`)
	zulipWide    = map[string]string{"all": "@all", "everyone": "@all", "stream": "@channel", "channel": "@channel", "topic": "@here"}
)

// zulipToMarkdown turns Zulip's mention and stream syntax into Cenacle's; the
// rest of Zulip's Markdown is kept.
func zulipToMarkdown(text string, byName map[string]string) string {
	text = zulipMention.ReplaceAllStringFunc(text, func(m string) string {
		sub := zulipMention.FindStringSubmatch(m)
		name, id := strings.TrimSpace(sub[1]), sub[2]
		if w, ok := zulipWide[name]; ok && id == "" {
			return w
		}
		if id == "" {
			id = byName[name]
		}
		if id == "" {
			return "@" + name
		}
		return Mention(id)
	})
	return zulipStreamL.ReplaceAllString(text, "#$1")
}
