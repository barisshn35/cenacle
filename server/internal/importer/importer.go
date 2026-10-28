// SPDX-License-Identifier: AGPL-3.0-only

// Package importer moves the history of another chat (Mattermost, Slack,
// Rocket.Chat, Zulip, Discord, Microsoft Teams) or of another Cenacle into
// Cenacle once: workspaces, people, channels, conversations and messages with
// their original times (from Cenacle also threads, reactions, pins and
// files). It reads files; it never connects to the other product. Running it
// again adds only what is missing.
package importer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
	Source   string // "mattermost", "slack", "cenacle"…
	Users    []User
	Channels []Channel
	Messages []Message
	// Workspaces gives the people of workspaces and their roles (optional).
	Workspaces []Workspace
	// OpenFile opens a file of the export by File.Key (exports with files).
	OpenFile func(key string) (io.ReadCloser, error)
}

// Workspace is a workspace of the export with its people.
type Workspace struct {
	Name    string
	Members []Member
}

// Member is a person of a workspace with their role there.
type Member struct {
	User string // user key
	Role string // a Cenacle workspace role (owner, admin, member, guest)
}

// User is a person of the export.
type User struct {
	Key         string
	Email       string
	DisplayName string
	// Admin is a workspace administrator in the source.
	Admin bool
	// AuthService and AuthData identify the person at the identity provider
	// (Cenacle exports): the same person on a server with the same Cenacle ID.
	AuthService, AuthData string
}

// Channel is a channel or a conversation of the export.
type Channel struct {
	Key       string
	Workspace string // the workspace name
	Name      string
	Topic     string
	Private   bool
	// Kind is a Cenacle channel kind (standard, announcement, forum); default standard.
	Kind string
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
	// Root is the key of the first message of the thread a reply belongs to.
	Root          string
	AlsoInChannel bool
	PinnedAt      time.Time // zero: not pinned
	// Title and Tags: a post of a forum.
	Title     string
	Tags      []string
	Reactions []Reaction
	Files     []File
}

// Reaction is an emoji and the people who reacted with it.
type Reaction struct {
	Emoji string
	Users []string // user keys
}

// File is a file of a message; Data.OpenFile reads it by Key.
type File struct {
	Key, Name, ContentType string
	Size                   int64
}

// mentionPrefix marks a person in a body until their Cenacle id is known.
const mentionPrefix = "\x00mention:"

// Mention references a person of the export in a message body.
func Mention(userKey string) string { return mentionPrefix + userKey + "\x00" }

// Result counts what an import did.
type Result struct {
	Workspaces, Users, Channels, Messages, Skipped int
}

// Options are the operator's choices for an import.
type Options struct {
	// Merge lets an import write into workspaces and channels of the same
	// names that it did not create. Without it such an import stops before
	// writing anything: an export's author must not be able to add people to
	// a native private channel or make them administrators. Even when
	// merging, people join those workspaces and channels as plain members and
	// nobody's role there changes.
	Merge bool
}

// DB starts transactions (pgxpool.Pool).
type DB interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

const batch = 1000

// Import writes the data. Messages go in batches of a thousand per
// transaction; everything before them in one. Files of messages are stored
// with files (nil: files are left out).
func Import(ctx context.Context, db DB, d Data, log *slog.Logger, files *chat.Files, opts Options) (Result, error) {
	var res Result
	users := map[string]store.User{}
	channels := map[string]store.Channel{}
	workspaces := map[string]store.Workspace{}
	// owned: created by an import (this one or an earlier one).
	ownedWorkspaces := map[string]bool{}
	err := inTx(ctx, db, func(q *store.Queries) error {
		var foreign []string // existing workspaces and channels an import did not create
		names := make([]string, 0, len(d.Workspaces)+len(d.Channels))
		for _, w := range d.Workspaces {
			names = append(names, w.Name)
		}
		for _, c := range d.Channels {
			names = append(names, c.Workspace)
		}
		for _, name := range names {
			if _, ok := workspaces[name]; ok {
				continue
			}
			ws, created, err := workspace(ctx, q, name)
			if err != nil {
				return err
			}
			owned, err := imported(ctx, created, ws.ID, q.MarkWorkspaceImported, q.IsWorkspaceImported)
			if err != nil {
				return err
			}
			if !owned && !opts.Merge {
				foreign = append(foreign, fmt.Sprintf("workspace %q", ws.Name))
			}
			ownedWorkspaces[name] = owned
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
			workspaces[name] = ws
		}
		if len(foreign) > 0 {
			return notCreated(foreign)
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
		for _, w := range d.Workspaces {
			ws := workspaces[w.Name]
			for _, m := range w.Members {
				u, ok := users[m.User]
				if !ok {
					continue
				}
				if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{
					WorkspaceID: ws.ID, UserID: u.ID, Role: chat.WorkspaceMember,
				}); err != nil {
					return err
				}
				if role := m.Role; ownedWorkspaces[w.Name] && role != chat.WorkspaceMember && validWorkspaceRole(role) {
					if err := q.SetWorkspaceMemberRole(ctx, store.SetWorkspaceMemberRoleParams{
						Role: role, WorkspaceID: ws.ID, UserID: u.ID,
					}); err != nil {
						return err
					}
				}
			}
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
			owned, err := imported(ctx, created, ch.ID, q.MarkChannelImported, q.IsChannelImported)
			if err != nil {
				return err
			}
			if !owned && !opts.Merge {
				what := fmt.Sprintf("channel %q of %q", ch.Name, ws.Name)
				if c.Conversation {
					what = fmt.Sprintf("a conversation of %d people in %q", len(members), ws.Name)
				}
				foreign = append(foreign, what)
				continue
			}
			if created {
				res.Channels++
			}
			channels[c.Key] = ch
			// A conversation's people are its key: nobody joins one an
			// import did not create.
			if !owned && c.Conversation {
				continue
			}
			managers := map[string]bool{}
			if owned {
				for _, k := range c.Managers {
					managers[k] = true
				}
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
		if len(foreign) > 0 {
			return notCreated(foreign)
		}
		for _, u := range d.Users {
			if !u.Admin {
				continue
			}
			for name, ws := range workspaces {
				if !ownedWorkspaces[name] {
					continue
				}
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
	ids := map[messageRef]pgtype.UUID{} // channel and message key → id, for replies
	for start := 0; start < len(msgs); start += batch {
		part := msgs[start:min(start+batch, len(msgs))]
		err := inTx(ctx, db, func(q *store.Queries) error {
			for _, m := range part {
				n, err := importMessage(ctx, q, d, m, channels, users, ids, files, workspaces, log)
				if err != nil {
					return err
				}
				if n == 0 {
					res.Skipped++
					continue
				}
				res.Messages += n
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
			if err := q.FollowImportedThreads(ctx, channels[key].ID); err != nil {
				return err
			}
		}
		return nil
	})
	return res, err
}

// importMessage stores one message with its reactions and files; it returns
// 0 when the message was skipped or is there already.
func importMessage(ctx context.Context, q *store.Queries, d Data, m Message, channels map[string]store.Channel,
	users map[string]store.User, ids map[messageRef]pgtype.UUID, files *chat.Files, workspaces map[string]store.Workspace,
	log *slog.Logger,
) (int, error) {
	ch, okc := channels[m.Channel]
	author, oka := users[m.Author]
	body := resolveMentions(m.Body, users)
	withFiles := len(m.Files) > 0 && files != nil && files.Store != nil && d.OpenFile != nil
	if !okc || !oka || (strings.TrimSpace(body) == "" && !withFiles) {
		return 0, nil
	}
	if r := []rune(body); len(r) > chat.MaxBodyLength {
		body = string(r[:chat.MaxBodyLength-1]) + "…"
	}
	// A reply's thread starts in its own channel (an export naming a root
	// elsewhere gets a message of its own).
	var root pgtype.UUID
	if m.Root != "" {
		root = ids[messageRef{ch.ID, m.Root}]
	}
	pinned := pgtype.Timestamptz{Time: m.PinnedAt, Valid: !m.PinnedAt.IsZero()}
	var pinnedBy pgtype.UUID
	if pinned.Valid {
		pinnedBy = author.ID
	}
	title := pgtype.Text{String: m.Title, Valid: m.Title != ""}
	tags := m.Tags
	if tags == nil {
		tags = []string{}
	}
	key := nonce(d.Source, m.Key)
	id, err := q.ImportMessage(ctx, store.ImportMessageParams{
		Shift:     pgtype.Interval{Microseconds: time.Until(m.At).Microseconds(), Valid: true},
		ChannelID: ch.ID, AuthorID: author.ID, Body: body, Nonce: key, CreatedAt: m.At,
		RootID: root, AlsoInChannel: m.AlsoInChannel && root.Valid, PinnedAt: pinned, PinnedBy: pinnedBy,
		Title: title, Tags: tags, HasFiles: withFiles,
	})
	if isNoRows(err) {
		// Imported before: remember it for its replies.
		if id, err = q.FindImportedMessage(ctx, store.FindImportedMessageParams{
			AuthorID: author.ID, Nonce: key, ChannelID: ch.ID,
		}); err == nil {
			ids[messageRef{ch.ID, m.Key}] = id
		}
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	ids[messageRef{ch.ID, m.Key}] = id
	for _, r := range m.Reactions {
		for _, k := range r.Users {
			u, ok := users[k]
			if !ok {
				continue
			}
			if err := q.ImportReaction(ctx, store.ImportReactionParams{
				MessageID: id, Emoji: r.Emoji, UserID: u.ID, CreatedAt: m.At,
			}); err != nil {
				return 0, err
			}
		}
	}
	if withFiles {
		for _, f := range m.Files {
			if f.Size < 0 || (files.MaxSize > 0 && f.Size > files.MaxSize) {
				log.Warn("file left out (larger than this server allows)", "message", m.Key, "file", f.Key, "size", f.Size)
				continue
			}
			if err := importFile(ctx, q, d, f, ch, author, id, m.At, files); err != nil {
				return 0, fmt.Errorf("file %s: %w", f.Key, err)
			}
		}
	}
	return 1, nil
}

func importFile(ctx context.Context, q *store.Queries, d Data, f File, ch store.Channel, author store.User,
	message pgtype.UUID, at time.Time, files *chat.Files,
) error {
	r, err := d.OpenFile(f.Key)
	if err != nil {
		return err
	}
	defer func() { _ = r.Close() }()
	name := cleanFileName(f.Name)
	contentType := f.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	row, err := q.ImportFile(ctx, store.ImportFileParams{
		WorkspaceID: ch.WorkspaceID, ChannelID: ch.ID, UploaderID: author.ID, MessageID: message,
		CreatedAt: pgtype.Timestamptz{Time: at, Valid: true}, Name: name, ContentType: contentType, Size: f.Size,
	})
	if err != nil {
		return err
	}
	return files.Ingest(ctx, q, row, r)
}

// messageRef names a message of the export in the channel it went to.
type messageRef struct {
	channel pgtype.UUID
	key     string
}

// cleanFileName keeps file names Cenacle accepts (1–255 characters).
func cleanFileName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < ' ' || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, name))
	if r := []rune(name); len(r) > 255 {
		name = string(r[:255])
	}
	if name == "" {
		name = "file"
	}
	return name
}

// imported tells whether an import created a workspace or channel, and
// records it when this one just did.
func imported(ctx context.Context, created bool, id pgtype.UUID,
	mark func(context.Context, pgtype.UUID) error, check func(context.Context, pgtype.UUID) (bool, error),
) (bool, error) {
	if created {
		return true, mark(ctx, id)
	}
	return check(ctx, id)
}

// notCreated refuses an import into existing workspaces or channels.
func notCreated(what []string) error {
	return fmt.Errorf("%s already exist and were not created by an import; "+
		"merge to import into them (people join as members, roles stay as they are)", strings.Join(what, ", "))
}

func validWorkspaceRole(role string) bool {
	switch role {
	case chat.WorkspaceOwner, chat.WorkspaceAdmin, chat.WorkspaceMember, chat.WorkspaceGuest:
		return true
	}
	return false
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
	// The same person at the same Cenacle ID.
	if u.AuthService != "" && u.AuthData != "" && u.AuthService != "import" {
		existing, err := q.GetUserByAuth(ctx, store.GetUserByAuthParams{AuthService: u.AuthService, AuthData: u.AuthData})
		if err == nil {
			return existing, false, nil
		}
		if !isNoRows(err) {
			return existing, false, err
		}
	}
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
	kind := chat.KindStandard
	if c.Kind == chat.KindAnnouncement || c.Kind == chat.KindForum {
		kind = c.Kind
	}
	ch, err := q.CreateChannel(ctx, store.CreateChannelParams{
		WorkspaceID: ws.ID, Name: name, Topic: topic, Kind: kind, Visibility: visibility, CreatedBy: creator,
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
