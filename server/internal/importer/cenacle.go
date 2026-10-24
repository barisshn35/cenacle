// SPDX-License-Identifier: AGPL-3.0-only

package importer

import (
	"archive/zip"
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"regexp"
	"time"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/barisshn35/cenacle/server/internal/chat"
	"github.com/barisshn35/cenacle/server/internal/store"
)

// A Cenacle export moves workspaces to another Cenacle server (server export,
// then server import cenacle): a .zip with cenacle-export.jsonl (one object
// per line, as below) and the files under files/<id>. Keys are the ids of the
// server that exported.

// ExportFormat is the version of the export; readers refuse newer ones.
const ExportFormat = 1

const (
	exportManifest = "cenacle-export.jsonl"
	exportFiles    = "files/"
)

type cnLine struct {
	Type      string       `json:"type"`
	Version   int          `json:"version,omitempty"`
	Server    string       `json:"server,omitempty"`
	At        *time.Time   `json:"exported_at,omitempty"`
	User      *cnUser      `json:"user,omitempty"`
	Workspace *cnWorkspace `json:"workspace,omitempty"`
	Channel   *cnChannel   `json:"channel,omitempty"`
	Message   *cnMessage   `json:"message,omitempty"`
}

type cnUser struct {
	Key         string `json:"key"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"display_name"`
	AuthService string `json:"auth_service"`
	AuthData    string `json:"auth_data"`
}

type cnMember struct {
	User string `json:"user"`
	Role string `json:"role"`
}

type cnWorkspace struct {
	Name    string     `json:"name"`
	Members []cnMember `json:"members"`
}

type cnChannel struct {
	Key          string     `json:"key"`
	Workspace    string     `json:"workspace"`
	Name         string     `json:"name"`
	Topic        string     `json:"topic,omitempty"`
	Kind         string     `json:"kind"`
	Private      bool       `json:"private,omitempty"`
	Conversation bool       `json:"conversation,omitempty"`
	Members      []cnMember `json:"members"`
}

type cnReaction struct {
	Emoji string   `json:"emoji"`
	Users []string `json:"users"`
}

type cnFile struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

type cnMessage struct {
	Key           string       `json:"key"`
	Channel       string       `json:"channel"`
	Author        string       `json:"author"`
	Body          string       `json:"body"`
	At            time.Time    `json:"at"`
	Root          string       `json:"root,omitempty"`
	AlsoInChannel bool         `json:"also_in_channel,omitempty"`
	PinnedAt      *time.Time   `json:"pinned_at,omitempty"`
	Title         string       `json:"title,omitempty"`
	Tags          []string     `json:"tags,omitempty"`
	Reactions     []cnReaction `json:"reactions,omitempty"`
	Files         []cnFile     `json:"files,omitempty"`
}

// ExportResult counts what an export wrote.
type ExportResult struct {
	Workspaces, Users, Channels, Messages, Files int
}

func (r ExportResult) String() string {
	return fmt.Sprintf("%d workspaces, %d people, %d channels, %d messages and %d files exported",
		r.Workspaces, r.Users, r.Channels, r.Messages, r.Files)
}

func key(id pgtype.UUID) string { return guuid.UUID(id.Bytes).String() }

// Export writes the named workspaces (none: all of them) as a Cenacle export.
// Files are included when files is set (else messages keep their text only).
func Export(ctx context.Context, q *store.Queries, w io.Writer, names []string, version string,
	files *chat.Files, log *slog.Logger,
) (ExportResult, error) {
	var res ExportResult
	if names == nil {
		names = []string{}
	}
	workspaces, err := q.MoveExportWorkspaces(ctx, names)
	if err != nil {
		return res, err
	}
	if len(workspaces) == 0 {
		return res, errors.New("no workspace to export")
	}
	zw := zip.NewWriter(w)
	manifest, err := zw.Create(exportManifest)
	if err != nil {
		return res, err
	}
	// Files go into the archive after the manifest: remember them.
	var blobs []store.File
	buf := bufio.NewWriter(manifest)
	enc := json.NewEncoder(buf)
	now := time.Now().UTC()
	if err := enc.Encode(cnLine{Type: "version", Version: ExportFormat, Server: version, At: &now}); err != nil {
		return res, err
	}
	people := map[pgtype.UUID]bool{}
	for _, ws := range workspaces {
		members, err := q.MoveExportWorkspaceMembers(ctx, ws.ID)
		if err != nil {
			return res, err
		}
		line := cnWorkspace{Name: ws.Name, Members: []cnMember{}}
		for _, m := range members {
			people[m.UserID] = true
			line.Members = append(line.Members, cnMember{User: key(m.UserID), Role: m.Role})
		}
		if err := enc.Encode(cnLine{Type: "workspace", Workspace: &line}); err != nil {
			return res, err
		}
		res.Workspaces++
		channels, err := q.MoveExportChannels(ctx, ws.ID)
		if err != nil {
			return res, err
		}
		for _, ch := range channels {
			if ch.Encrypted {
				// Its messages are readable only with the channel's passphrase.
				log.Warn("encrypted channel left out", "workspace", ws.Name, "channel", ch.Name)
				continue
			}
			cm, err := q.MoveExportChannelMembers(ctx, ch.ID)
			if err != nil {
				return res, err
			}
			line := cnChannel{
				Key: key(ch.ID), Workspace: ws.Name, Name: ch.Name, Topic: ch.Topic, Kind: ch.Kind,
				Private:      ch.Visibility == chat.Private,
				Conversation: ch.Kind == chat.KindDirect || ch.Kind == chat.KindGroup,
				Members:      []cnMember{},
			}
			for _, m := range cm {
				people[m.UserID] = true
				line.Members = append(line.Members, cnMember{User: key(m.UserID), Role: m.Role})
			}
			if err := enc.Encode(cnLine{Type: "channel", Channel: &line}); err != nil {
				return res, err
			}
			res.Channels++
			n, more, err := exportMessages(ctx, q, enc, ch, people, files != nil && files.Store != nil)
			if err != nil {
				return res, err
			}
			res.Messages += n
			blobs = append(blobs, more...)
		}
		log.Info("workspace exported", "workspace", ws.Name, "messages", res.Messages)
	}
	ids := make([]pgtype.UUID, 0, len(people))
	for id := range people {
		ids = append(ids, id)
	}
	users, err := q.MoveExportUsers(ctx, ids)
	if err != nil {
		return res, err
	}
	for _, u := range users {
		if err := enc.Encode(cnLine{Type: "user", User: &cnUser{
			Key: key(u.ID), Email: u.Email, DisplayName: u.DisplayName, AuthService: u.AuthService, AuthData: u.AuthData,
		}}); err != nil {
			return res, err
		}
		res.Users++
	}
	if err := buf.Flush(); err != nil {
		return res, err
	}
	for _, f := range blobs {
		if err := exportFile(ctx, zw, files, f); err != nil {
			return res, fmt.Errorf("file %s: %w", key(f.ID), err)
		}
		res.Files++
	}
	return res, zw.Close()
}

// exportMessages writes the messages of a channel; it returns the files to
// add to the archive.
func exportMessages(ctx context.Context, q *store.Queries, enc *json.Encoder, ch store.Channel,
	people map[pgtype.UUID]bool, withFiles bool,
) (int, []store.File, error) {
	var count int
	var blobs []store.File
	after := pgtype.UUID{Valid: true} // the zero uuid: before every message
	for {
		page, err := q.MoveExportMessages(ctx, store.MoveExportMessagesParams{ChannelID: ch.ID, After: after, PageSize: 1000})
		if err != nil {
			return count, blobs, err
		}
		if len(page) == 0 {
			return count, blobs, nil
		}
		ids := make([]pgtype.UUID, len(page))
		for i, m := range page {
			ids[i] = m.ID
		}
		reactions, err := q.MoveExportReactions(ctx, ids)
		if err != nil {
			return count, blobs, err
		}
		byMessage := map[pgtype.UUID][]cnReaction{}
		for _, r := range reactions {
			people[r.UserID] = true
			list := byMessage[r.MessageID]
			if n := len(list); n > 0 && list[n-1].Emoji == r.Emoji {
				list[n-1].Users = append(list[n-1].Users, key(r.UserID))
			} else {
				list = append(list, cnReaction{Emoji: r.Emoji, Users: []string{key(r.UserID)}})
			}
			byMessage[r.MessageID] = list
		}
		filesOf := map[pgtype.UUID][]cnFile{}
		if withFiles {
			fs, err := q.MoveExportFiles(ctx, ids)
			if err != nil {
				return count, blobs, err
			}
			for _, f := range fs {
				filesOf[f.MessageID] = append(filesOf[f.MessageID], cnFile{
					Key: key(f.ID), Name: f.Name, ContentType: f.ContentType, Size: f.Size,
				})
				blobs = append(blobs, f)
			}
		}
		for _, m := range page {
			people[m.AuthorID] = true
			line := cnMessage{
				Key: key(m.ID), Channel: key(ch.ID), Author: key(m.AuthorID), Body: m.Body, At: m.CreatedAt.UTC(),
				AlsoInChannel: m.AlsoInChannel, Title: m.Title.String, Tags: m.Tags,
				Reactions: byMessage[m.ID], Files: filesOf[m.ID],
			}
			if m.RootID.Valid {
				line.Root = key(m.RootID)
			}
			if m.PinnedAt.Valid {
				t := m.PinnedAt.Time.UTC()
				line.PinnedAt = &t
			}
			if err := enc.Encode(cnLine{Type: "message", Message: &line}); err != nil {
				return count, blobs, err
			}
			count++
		}
		after = page[len(page)-1].ID
	}
}

func exportFile(ctx context.Context, zw *zip.Writer, files *chat.Files, f store.File) error {
	obj, err := files.Open(ctx, f)
	if err != nil {
		return err
	}
	defer func() { _ = obj.Close() }()
	w, err := zw.CreateHeader(&zip.FileHeader{Name: exportFiles + key(f.ID), Method: zip.Store})
	if err != nil {
		return err
	}
	_, err = io.Copy(w, obj)
	return err
}

var cenacleMention = regexp.MustCompile(`<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>`)

// ReadCenacle reads a Cenacle export.
func ReadCenacle(fsys fs.FS) (Data, error) {
	d := Data{Source: "cenacle"}
	name, err := findFile(fsys, exportManifest)
	if err != nil {
		return d, fmt.Errorf("%w: is this a Cenacle export?", err)
	}
	f, err := fsys.Open(name)
	if err != nil {
		return d, err
	}
	defer func() { _ = f.Close() }()
	dir := name[:len(name)-len(exportManifest)]
	dec := json.NewDecoder(bufio.NewReader(f))
	seenVersion := false
	for dec.More() {
		var l cnLine
		if err := dec.Decode(&l); err != nil {
			return d, fmt.Errorf("%s: %w", exportManifest, err)
		}
		switch {
		case l.Type == "version":
			if l.Version < 1 || l.Version > ExportFormat {
				return d, fmt.Errorf("export format %d is newer than this server reads (%d): upgrade first", l.Version, ExportFormat)
			}
			seenVersion = true
		case !seenVersion:
			return d, errors.New("the export does not start with its version")
		case l.Type == "user" && l.User != nil:
			u := l.User
			d.Users = append(d.Users, User{
				Key: u.Key, Email: u.Email, DisplayName: u.DisplayName, AuthService: u.AuthService, AuthData: u.AuthData,
			})
		case l.Type == "workspace" && l.Workspace != nil:
			w := Workspace{Name: l.Workspace.Name}
			for _, m := range l.Workspace.Members {
				w.Members = append(w.Members, Member(m))
			}
			d.Workspaces = append(d.Workspaces, w)
		case l.Type == "channel" && l.Channel != nil:
			c := l.Channel
			ch := Channel{
				Key: c.Key, Workspace: c.Workspace, Name: c.Name, Topic: c.Topic, Kind: c.Kind,
				Private: c.Private, Conversation: c.Conversation,
			}
			for _, m := range c.Members {
				ch.Members = append(ch.Members, m.User)
				if m.Role == chat.RoleManager {
					ch.Managers = append(ch.Managers, m.User)
				}
			}
			d.Channels = append(d.Channels, ch)
		case l.Type == "message" && l.Message != nil:
			m := l.Message
			msg := Message{
				Key: m.Key, Channel: m.Channel, Author: m.Author, At: m.At, Root: m.Root,
				AlsoInChannel: m.AlsoInChannel, Title: m.Title, Tags: m.Tags,
				Body: cenacleMention.ReplaceAllStringFunc(m.Body, func(s string) string {
					return Mention(cenacleMention.FindStringSubmatch(s)[1])
				}),
			}
			if m.PinnedAt != nil {
				msg.PinnedAt = *m.PinnedAt
			}
			for _, r := range m.Reactions {
				msg.Reactions = append(msg.Reactions, Reaction(r))
			}
			for _, f := range m.Files {
				msg.Files = append(msg.Files, File(f))
			}
			d.Messages = append(d.Messages, msg)
		}
	}
	d.OpenFile = func(key string) (io.ReadCloser, error) {
		if _, err := guuid.Parse(key); err != nil {
			return nil, fmt.Errorf("bad file key %q", key)
		}
		return fsys.Open(dir + exportFiles + key)
	}
	return d, nil
}
