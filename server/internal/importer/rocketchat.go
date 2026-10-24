// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Rocket.Chat has no export of a whole server; its data is in MongoDB. The
// importer reads mongoexport output of four collections (JSON lines or
// --jsonArray), in a directory or archive:
//
//	users.json, rocketchat_room.json, rocketchat_subscription.json,
//	rocketchat_message.json
//
// (each may also carry the database prefix, e.g. rocketchat.users.json).

type rcUser struct {
	ID       string   `json:"_id"`
	Username string   `json:"username"`
	Name     string   `json:"name"`
	Roles    []string `json:"roles"`
	Emails   []struct {
		Address string `json:"address"`
	} `json:"emails"`
}

type rcRoom struct {
	ID        string   `json:"_id"`
	Type      string   `json:"t"` // c public, p private, d direct
	Name      string   `json:"name"`
	FName     string   `json:"fname"`
	Topic     string   `json:"topic"`
	Desc      string   `json:"description"`
	UIDs      []string `json:"uids"`
	Usernames []string `json:"usernames"`
}

type rcSubscription struct {
	Room  string   `json:"rid"`
	Roles []string `json:"roles"`
	User  struct {
		ID string `json:"_id"`
	} `json:"u"`
}

type rcMessage struct {
	ID   string    `json:"_id"`
	Room string    `json:"rid"`
	Text string    `json:"msg"`
	Type string    `json:"t"` // set on system messages (joins, renames…)
	At   mongoTime `json:"ts"`
	User struct {
		ID string `json:"_id"`
	} `json:"u"`
}

// mongoTime reads MongoDB extended JSON dates: {"$date": "…"},
// {"$date": {"$numberLong": "…"}}, {"$date": ms} or a plain string.
type mongoTime struct{ time.Time }

func (t *mongoTime) UnmarshalJSON(b []byte) error {
	var wrapped struct {
		Date json.RawMessage `json:"$date"`
	}
	if len(b) > 0 && b[0] == '{' {
		if err := json.Unmarshal(b, &wrapped); err != nil {
			return err
		}
		b = wrapped.Date
	}
	var long struct {
		N string `json:"$numberLong"`
	}
	if len(b) > 0 && b[0] == '{' {
		if err := json.Unmarshal(b, &long); err != nil {
			return err
		}
		b = []byte(long.N)
	}
	s := strings.Trim(string(b), `"`)
	if ms, err := strconv.ParseInt(s, 10, 64); err == nil {
		t.Time = time.UnixMilli(ms).UTC()
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, s)
	t.Time = parsed.UTC()
	return err
}

// readDocs calls fn for each document of a mongoexport file.
func readDocs(fsys fs.FS, name string, fn func(json.RawMessage) error) error {
	f, err := fsys.Open(name)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	r := bufio.NewReader(io.LimitReader(f, 16<<30))
	first, err := peekNonSpace(r)
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	dec := json.NewDecoder(r)
	if first == '[' {
		if _, err := dec.Token(); err != nil {
			return err
		}
	}
	for dec.More() {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if err := fn(raw); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

func peekNonSpace(r *bufio.Reader) (byte, error) {
	for {
		b, err := r.Peek(1)
		if err != nil {
			return 0, err
		}
		if !bytes.ContainsAny(b, " \t\r\n") {
			return b[0], nil
		}
		if _, err := r.ReadByte(); err != nil {
			return 0, err
		}
	}
}

// findCollection finds a mongoexport file by collection name, with or without
// a database prefix.
func findCollection(fsys fs.FS, collection string) (string, error) {
	var found string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		base := strings.TrimSuffix(path.Base(p), path.Ext(p))
		if !d.IsDir() && (base == collection || strings.HasSuffix(base, "."+collection)) {
			found = p
			return fs.SkipAll
		}
		return nil
	})
	if err == nil && found == "" {
		err = fmt.Errorf("%s.json is missing: is this a mongoexport of Rocket.Chat?", collection)
	}
	return found, err
}

// ReadRocketChat reads a Rocket.Chat database export into one workspace.
func ReadRocketChat(fsys fs.FS, workspace string) (Data, error) {
	d := Data{Source: "rocketchat"}
	names := map[string]string{} // collection → file
	for _, c := range []string{"users", "rocketchat_room", "rocketchat_subscription", "rocketchat_message"} {
		p, err := findCollection(fsys, c)
		if err != nil {
			return d, err
		}
		names[c] = p
	}
	byUsername := map[string]string{}
	err := readDocs(fsys, names["users"], func(raw json.RawMessage) error {
		var u rcUser
		if err := json.Unmarshal(raw, &u); err != nil {
			return err
		}
		email := ""
		if len(u.Emails) > 0 {
			email = u.Emails[0].Address
		}
		d.Users = append(d.Users, User{
			Key: u.ID, Email: email, DisplayName: firstNonEmpty(u.Name, u.Username),
			Admin: slices.Contains(u.Roles, "admin"),
		})
		byUsername[u.Username] = u.ID
		return nil
	})
	if err != nil {
		return d, err
	}
	members := map[string][]string{}
	owners := map[string][]string{}
	err = readDocs(fsys, names["rocketchat_subscription"], func(raw json.RawMessage) error {
		var s rcSubscription
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		members[s.Room] = append(members[s.Room], s.User.ID)
		if slices.Contains(s.Roles, "owner") || slices.Contains(s.Roles, "moderator") {
			owners[s.Room] = append(owners[s.Room], s.User.ID)
		}
		return nil
	})
	if err != nil {
		return d, err
	}
	err = readDocs(fsys, names["rocketchat_room"], func(raw json.RawMessage) error {
		var r rcRoom
		if err := json.Unmarshal(raw, &r); err != nil {
			return err
		}
		switch r.Type {
		case "c", "p":
			d.Channels = append(d.Channels, Channel{
				Key: r.ID, Workspace: workspace, Name: firstNonEmpty(r.FName, r.Name),
				Topic: firstNonEmpty(r.Topic, r.Desc), Private: r.Type == "p",
				Members: members[r.ID], Managers: owners[r.ID],
			})
		case "d":
			ids := r.UIDs
			if len(ids) == 0 {
				for _, n := range r.Usernames {
					ids = append(ids, byUsername[n])
				}
			}
			d.Channels = append(d.Channels, Channel{
				Key: r.ID, Workspace: workspace, Private: true, Conversation: true, Members: ids,
			})
		}
		// Livechat ("l") and other room types are not conversations of the team.
		return nil
	})
	if err != nil {
		return d, err
	}
	err = readDocs(fsys, names["rocketchat_message"], func(raw json.RawMessage) error {
		var m rcMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			return err
		}
		if m.Type != "" || m.User.ID == "" || m.At.IsZero() {
			return nil
		}
		d.Messages = append(d.Messages, Message{
			Key: m.ID, Channel: m.Room, Author: m.User.ID, At: m.At.Time,
			Body: rocketToMarkdown(m.Text, byUsername),
		})
		return nil
	})
	return d, err
}

var rcMention = regexp.MustCompile(`(^|[^\w@])@([\w.\-]+)`)

// rocketToMarkdown keeps Rocket.Chat's Markdown and makes @username mentions
// references to the people of the export.
func rocketToMarkdown(text string, byUsername map[string]string) string {
	return rcMention.ReplaceAllStringFunc(text, func(m string) string {
		sub := rcMention.FindStringSubmatch(m)
		switch sub[2] {
		case "all":
			return sub[1] + "@all"
		case "here":
			return sub[1] + "@here"
		}
		if id, ok := byUsername[sub[2]]; ok {
			return sub[1] + Mention(id)
		}
		return m
	})
}
