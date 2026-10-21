// SPDX-License-Identifier: Apache-2.0

// Package importer moves the history of another chat (a Mattermost bulk export
// or a Slack export) into Cenacle once: workspaces, people, channels,
// conversations and messages with their original times. It reads files; it
// never connects to the other product. Running it again adds only what is
// missing.
package importer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// Data is an export in Cenacle's terms. Keys are the source's own ids or
// names; Body texts may reference people as Mention(userKey).
type Data struct {
	Source   string // "mattermost" or "slack"
	Users    []User
	Channels []Channel
	Messages []Message
}

// User is a person of the export.
type User struct {
	Key         string
	Email       string
	DisplayName string
	// Admin is a workspace administrator in the source.
	Admin bool
}

// Channel is a channel or a conversation of the export.
type Channel struct {
	Key       string
	Workspace string // the workspace name
	Name      string
	Topic     string
	Private   bool
	// Conversation: a direct or group conversation (Name is ignored).
	Conversation bool
	Members      []string // user keys
	Managers     []string // user keys
}

// Message is a message of a channel.
type Message struct {
	Key     string // unique within the export (for importing again)
	Channel string
	Author  string
	Body    string
	At      time.Time
}

// mentionPrefix marks a person in a body until their Cenacle id is known.
const mentionPrefix = "\x00mention:"

// Mention references a person of the export in a message body.
func Mention(userKey string) string { return mentionPrefix + userKey + "\x00" }

// Result counts what an import did.
type Result struct {
	Workspaces, Users, Channels, Messages, Skipped int
}

// DB starts transactions (pgxpool.Pool).
type DB interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

const batch = 1000

// Import writes the data. Messages go in batches of a thousand per
// transaction; everything before them in one.
func Import(ctx context.Context, db DB, d Data, log *slog.Logger) (Result, error) {
	var res Result
	users := map[string]store.User{}
	channels := map[string]store.Channel{}
	err := inTx(ctx, db, func(q *store.Queries) error {
		workspaces := map[string]store.Workspace{}
		for _, c := range d.Channels {
			if _, ok := workspaces[c.Workspace]; ok {
				continue
			}
			ws, created, err := workspace(ctx, q, c.Workspace)
			if err != nil {
				return err
			}
			if created {
				res.Workspaces++
				// A new workspace belongs to the instance administrator.
				admin, err := q.GetInstanceAdmin(ctx)
				if err == nil {
					if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{
						WorkspaceID: ws.ID, UserID: admin.ID, Role: chat.WorkspaceOwner,
					}); err != nil {
						return err
					}
				} else if !isNoRows(err) {
					return err
				}
			}
			workspaces[c.Workspace] = ws
		}
		for _, u := range d.Users {
			cu, created, err := user(ctx, q, d.Source, u)
			if err != nil {
				return err
			}
			if created {
				res.Users++
			}
			users[u.Key] = cu
		}
		admins := map[string]bool{}
		for _, u := range d.Users {
			admins[u.Key] = u.Admin
		}
		for _, c := range d.Channels {
			ws := workspaces[c.Workspace]
			var members []store.User
			for _, k := range c.Members {
				if u, ok := users[k]; ok {
					members = append(members, u)
				}
			}
			for _, u := range members {
				if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{
					WorkspaceID: ws.ID, UserID: u.ID, Role: chat.WorkspaceMember,
				}); err != nil {
					return err
				}
			}
			ch, created, err := channel(ctx, q, ws, c, members)
			if err != nil {
				return err
			}
			if !ok(ch) {
				log.Warn("conversation skipped (needs two people)", "channel", c.Key)
				continue
			}
			if created {
				res.Channels++
			}
			channels[c.Key] = ch
			managers := map[string]bool{}
			for _, k := range c.Managers {
				managers[k] = true
			}
			for _, k := range c.Members {
				u, found := users[k]
				if !found {
					continue
				}
				role := chat.RoleMember
				if managers[k] && !c.Conversation {
					role = chat.RoleManager
				}
				if _, err := q.AddMember(ctx, store.AddMemberParams{ChannelID: ch.ID, UserID: u.ID, Role: role}); err != nil {
					return err
				}
			}
		}
		for _, u := range d.Users {
			if !u.Admin {
				continue
			}
			for _, ws := range workspaces {
				if err := q.SetWorkspaceMemberRole(ctx, store.SetWorkspaceMemberRoleParams{
					Role: chat.WorkspaceAdmin, WorkspaceID: ws.ID, UserID: users[u.Key].ID,
				}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return res, err
	}

	msgs := append([]Message(nil), d.Messages...)
	sort.SliceStable(msgs, func(i, j int) bool { return msgs[i].At.Before(msgs[j].At) })
	touched := map[string]bool{}
	for start := 0; start < len(msgs); start += batch {
		part := msgs[start:min(start+batch, len(msgs))]
		err := inTx(ctx, db, func(q *store.Queries) error {
			now := time.Now()
			for _, m := range part {
				ch, okc := channels[m.Channel]
				author, oka := users[m.Author]
				body := resolveMentions(m.Body, users)
				if !okc || !oka || strings.TrimSpace(body) == "" {
					res.Skipped++
					continue
				}
				if r := []rune(body); len(r) > chat.MaxBodyLength {
					body = string(r[:chat.MaxBodyLength-1]) + "…"
				}
				n, err := q.ImportMessage(ctx, store.ImportMessageParams{
					Shift:     pgtype.Interval{Microseconds: m.At.Sub(now).Microseconds(), Valid: true},
					ChannelID: ch.ID, AuthorID: author.ID, Body: body,
					Nonce: nonce(d.Source, m.Key), CreatedAt: m.At,
				})
				if err != nil {
					return err
				}
				res.Messages += int(n)
				touched[m.Channel] = true
			}
			return nil
		})
		if err != nil {
			return res, err
		}
		log.Info("messages imported", "done", min(start+batch, len(msgs)), "of", len(msgs))
	}
	// History is read: nobody starts with thousands of unread messages.
	err = inTx(ctx, db, func(q *store.Queries) error {
		for key := range touched {
			if err := q.MarkChannelReadForAll(ctx, channels[key].ID); err != nil {
				return err
			}
		}
		return nil
	})
	return res, err
}

func ok(c store.Channel) bool { return c.ID.Valid }

func inTx(ctx context.Context, db DB, fn func(q *store.Queries) error) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(store.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func workspace(ctx context.Context, q *store.Queries, name string) (store.Workspace, bool, error) {
	name = strings.TrimSpace(name)
	if r := []rune(name); len(r) > 80 {
		name = strings.TrimSpace(string(r[:80]))
	}
	ws, err := q.FindWorkspaceByName(ctx, name)
	if err == nil {
		return ws, false, nil
	}
	if !isNoRows(err) {
		return ws, false, err
	}
	ws, err = q.CreateWorkspace(ctx, store.CreateWorkspaceParams{Name: name})
	return ws, err == nil, err
}

func user(ctx context.Context, q *store.Queries, source string, u User) (store.User, bool, error) {
	email := strings.ToLower(strings.TrimSpace(u.Email))
	if email != "" {
		existing, err := q.FindUserByEmail(ctx, email)
		if err == nil {
			return existing, false, nil
		}
		if !isNoRows(err) {
			return existing, false, err
		}
	}
	// People without an address (bots, deleted accounts) keep their messages
	// but cannot sign in.
	key := email
	if key == "" {
		key = source + ":" + u.Key
	}
	name := strings.TrimSpace(u.DisplayName)
	if name == "" {
		name = u.Key
	}
	created, err := q.CreateImportedUser(ctx, store.CreateImportedUserParams{AuthData: key, Email: email, DisplayName: name})
	return created, err == nil, err
}

func channel(ctx context.Context, q *store.Queries, ws store.Workspace, c Channel, members []store.User) (store.Channel, bool, error) {
	if c.Conversation {
		if len(members) < 2 {
			return store.Channel{}, false, nil
		}
		ids := make([]string, 0, len(members))
		for _, u := range members {
			ids = append(ids, guuid.UUID(u.ID.Bytes).String())
		}
		kind, key := chat.ConversationKey(ids)
		existing, err := q.GetChannelByName(ctx, store.GetChannelByNameParams{WorkspaceID: ws.ID, Name: key})
		if err == nil {
			return existing, false, nil
		}
		ch, err := q.CreateConversation(ctx, store.CreateConversationParams{
			WorkspaceID: ws.ID, Name: key, Kind: kind, CreatedBy: members[0].ID,
		})
		return ch, err == nil, err
	}
	name := cleanName(c.Name)
	existing, err := q.GetChannelByName(ctx, store.GetChannelByNameParams{WorkspaceID: ws.ID, Name: name})
	if err == nil {
		return existing, false, nil
	}
	if !isNoRows(err) {
		return existing, false, err
	}
	visibility := chat.Public
	if c.Private {
		visibility = chat.Private
	}
	var creator pgtype.UUID
	if len(members) > 0 {
		creator = members[0].ID
	}
	topic := c.Topic
	if r := []rune(topic); len(r) > chat.MaxTopic {
		topic = string(r[:chat.MaxTopic])
	}
	ch, err := q.CreateChannel(ctx, store.CreateChannelParams{
		WorkspaceID: ws.ID, Name: name, Topic: topic, Kind: chat.KindStandard, Visibility: visibility, CreatedBy: creator,
	})
	return ch, err == nil, err
}

// cleanName keeps names Cenacle accepts.
func cleanName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < ' ' {
			return -1
		}
		return r
	}, name))
	if strings.HasPrefix(name, "direct:") || strings.HasPrefix(name, "group:") {
		name = "_" + name
	}
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	if name == "" {
		name = "imported"
	}
	return name
}

func resolveMentions(body string, users map[string]store.User) string {
	for {
		i := strings.Index(body, mentionPrefix)
		if i < 0 {
			return body
		}
		rest := body[i+len(mentionPrefix):]
		j := strings.IndexByte(rest, 0)
		if j < 0 {
			return body[:i]
		}
		key := rest[:j]
		replacement := "@" + key
		if u, ok := users[key]; ok {
			replacement = "<@" + guuid.UUID(u.ID.Bytes).String() + ">"
		}
		body = body[:i] + replacement + rest[j+1:]
	}
}

// nonce makes a message's import key a nonce (8–64 characters).
func nonce(source, key string) string {
	sum := sha256.Sum256([]byte(source + "\x00" + key))
	return "import-" + hex.EncodeToString(sum[:])[:40]
}

// Summary is a one-line report.
func (r Result) String() string {
	return fmt.Sprintf("%d workspaces, %d people, %d channels and %d messages added (%d messages skipped)",
		r.Workspaces, r.Users, r.Channels, r.Messages, r.Skipped)
}
