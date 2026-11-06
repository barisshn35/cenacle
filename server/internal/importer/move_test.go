// SPDX-License-Identifier: AGPL-3.0-only

package importer_test

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	guuid "github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Cenacle-TR/cenacle/server/internal/chat"
	"github.com/Cenacle-TR/cenacle/server/internal/importer"
	"github.com/Cenacle-TR/cenacle/server/internal/storage"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
	"github.com/Cenacle-TR/cenacle/server/internal/testdb"
)

func dirFiles(t *testing.T) *chat.Files {
	t.Helper()
	d, err := storage.NewDir(t.TempDir(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	return chat.NewFiles(d, nil, 10<<20)
}

func person(t *testing.T, q *store.Queries, sub, email, name string) store.User {
	t.Helper()
	u, err := q.UpsertUserFromIdentity(context.Background(), store.UpsertUserFromIdentityParams{
		AuthService: "cenacle-id", AuthData: sub, Email: email, EmailVerified: true, DisplayName: name,
	})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func message(t *testing.T, pool *pgxpool.Pool, ch, author pgtype.UUID, body string, root pgtype.UUID, at time.Time) pgtype.UUID {
	t.Helper()
	var id pgtype.UUID
	if err := pool.QueryRow(context.Background(), `INSERT INTO messages (channel_id, author_id, body, nonce, created_at, root_id)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, ch, author, body, "nonce-"+testdb.Suffix(), at, root).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestMoveBetweenServers(t *testing.T) {
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// The server the workspace leaves.
	src := testdb.Open(t)
	q := store.New(src)
	ayse := person(t, q, "sub-ayse", "ayse@example.com", "Ayşe")
	mert := person(t, q, "sub-mert", "mert@example.com", "Mert")
	ws, err := q.CreateWorkspace(ctx, store.CreateWorkspaceParams{Name: "Acme"})
	if err != nil {
		t.Fatal(err)
	}
	for u, role := range map[pgtype.UUID]string{ayse.ID: chat.WorkspaceOwner, mert.ID: chat.WorkspaceMember} {
		if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{WorkspaceID: ws.ID, UserID: u, Role: role}); err != nil {
			t.Fatal(err)
		}
	}
	ch, err := q.CreateChannel(ctx, store.CreateChannelParams{
		WorkspaceID: ws.ID, Name: "plans", Topic: "Plans", Kind: chat.KindForum, Visibility: chat.Private, CreatedBy: ayse.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := q.CreateChannel(ctx, store.CreateChannelParams{
		WorkspaceID: ws.ID, Name: "secret", Kind: chat.KindStandard, Visibility: chat.Private, CreatedBy: ayse.ID,
		Encrypted: true, KeyCheck: "check",
	})
	if err != nil {
		t.Fatal(err)
	}
	for u, role := range map[pgtype.UUID]string{ayse.ID: chat.RoleManager, mert.ID: chat.RoleMember} {
		if _, err := q.AddMember(ctx, store.AddMemberParams{ChannelID: ch.ID, UserID: u, Role: role}); err != nil {
			t.Fatal(err)
		}
	}
	at := time.Date(2025, 3, 1, 9, 0, 0, 0, time.UTC)
	root := message(t, src, ch.ID, ayse.ID, "Plan for <@"+guuid.UUID(mert.ID.Bytes).String()+">", pgtype.UUID{}, at)
	reply := message(t, src, ch.ID, mert.ID, "Looks good", root, at.Add(time.Minute))
	_ = message(t, src, secret.ID, ayse.ID, "ciphertext", pgtype.UUID{}, at)
	if _, err := src.Exec(ctx, `UPDATE messages SET pinned_at = $2, pinned_by = author_id, title = 'Q2', tags = '{plan}' WHERE id = $1`,
		root, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Exec(ctx, `INSERT INTO message_reactions (message_id, emoji, user_id) VALUES ($1, '👍', $2), ($1, '👍', $3)`,
		root, mert.ID, ayse.ID); err != nil {
		t.Fatal(err)
	}
	srcFiles := dirFiles(t)
	content := []byte("quarterly plan, version 2")
	f, err := q.ImportFile(ctx, store.ImportFileParams{
		WorkspaceID: ws.ID, ChannelID: ch.ID, UploaderID: mert.ID, MessageID: reply,
		CreatedAt: pgtype.Timestamptz{Time: at, Valid: true}, Name: "plan.txt", ContentType: "text/plain", Size: int64(len(content)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := srcFiles.Ingest(ctx, q, f, bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Exec(ctx, `UPDATE messages SET has_files = true WHERE id = $1`, reply); err != nil {
		t.Fatal(err)
	}

	var archive bytes.Buffer
	res, err := importer.Export(ctx, q, &archive, []string{"Acme"}, "0.38.0-test", srcFiles, log)
	if err != nil {
		t.Fatal(err)
	}
	if res.Workspaces != 1 || res.Channels != 1 || res.Messages != 2 || res.Files != 1 || res.Users != 2 {
		t.Errorf("export = %+v", res)
	}

	// The server it arrives at: Mert is there already, with another address.
	dst := testdb.Open(t)
	q2 := store.New(dst)
	mert2 := person(t, q2, "sub-mert", "mert@new.example", "Mert K")
	zr, err := zip.NewReader(bytes.NewReader(archive.Bytes()), int64(archive.Len()))
	if err != nil {
		t.Fatal(err)
	}
	d, err := importer.ReadCenacle(zr)
	if err != nil {
		t.Fatal(err)
	}
	dstFiles := dirFiles(t)
	got, err := importer.Import(ctx, dst, d, log, dstFiles, importer.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Workspaces != 1 || got.Users != 1 || got.Channels != 1 || got.Messages != 2 || got.Skipped != 0 {
		t.Errorf("import = %+v", got)
	}
	again, err := importer.Import(ctx, dst, d, log, dstFiles, importer.Options{})
	if err != nil || again.Messages != 0 || again.Skipped != 2 {
		t.Errorf("again = %+v, %v", again, err)
	}

	ws2, err := q2.FindWorkspaceByName(ctx, "Acme")
	if err != nil {
		t.Fatal(err)
	}
	var role string
	if err := dst.QueryRow(ctx, `SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = $1 AND u.email = 'ayse@example.com'`, ws2.ID).Scan(&role); err != nil || role != chat.WorkspaceOwner {
		t.Errorf("Ayşe's role = %q, %v", role, err)
	}
	ch2, err := q2.GetChannelByName(ctx, store.GetChannelByNameParams{WorkspaceID: ws2.ID, Name: "plans"})
	if err != nil || ch2.Kind != chat.KindForum || ch2.Visibility != chat.Private {
		t.Fatalf("channel = %+v, %v", ch2, err)
	}
	var (
		rootBody, title string
		pinned          bool
		tags            []string
		replyRoot       pgtype.UUID
		rootID          pgtype.UUID
		reactions       int
	)
	if err := dst.QueryRow(ctx, `SELECT id, body, title, tags, pinned_at IS NOT NULL FROM messages WHERE channel_id = $1 AND root_id IS NULL`,
		ch2.ID).Scan(&rootID, &rootBody, &title, &tags, &pinned); err != nil {
		t.Fatal(err)
	}
	if rootBody != "Plan for <@"+guuid.UUID(mert2.ID.Bytes).String()+">" || title != "Q2" || len(tags) != 1 || !pinned {
		t.Errorf("root = %q %q %v %v", rootBody, title, tags, pinned)
	}
	if err := dst.QueryRow(ctx, `SELECT root_id FROM messages WHERE channel_id = $1 AND author_id = $2`, ch2.ID, mert2.ID).Scan(&replyRoot); err != nil || replyRoot != rootID {
		t.Errorf("reply root = %v, %v", replyRoot, err)
	}
	if err := dst.QueryRow(ctx, `SELECT count(*) FROM message_reactions WHERE message_id = $1`, rootID).Scan(&reactions); err != nil || reactions != 2 {
		t.Errorf("reactions = %d, %v", reactions, err)
	}
	var follows int
	if err := dst.QueryRow(ctx, `SELECT count(*) FROM thread_follows WHERE root_id = $1`, rootID).Scan(&follows); err != nil || follows != 2 {
		t.Errorf("thread follows = %d, %v", follows, err)
	}
	var file store.File
	if err := dst.QueryRow(ctx, `SELECT id, status, name, size FROM files WHERE channel_id = $1`, ch2.ID).Scan(
		&file.ID, &file.Status, &file.Name, &file.Size); err != nil || file.Status != "ready" || file.Name != "plan.txt" {
		t.Fatalf("file = %+v, %v", file, err)
	}
	obj, err := dstFiles.Open(ctx, file)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(obj)
	_ = obj.Close()
	if !bytes.Equal(b, content) {
		t.Errorf("file content = %q", b)
	}
	if _, err := q2.GetChannelByName(ctx, store.GetChannelByNameParams{WorkspaceID: ws2.ID, Name: "secret"}); err == nil {
		t.Error("the encrypted channel was moved")
	}
	if strings.Contains(archive.String(), "ciphertext") {
		t.Error("the export holds an encrypted channel's messages")
	}
}

func TestReadCenacleRefusesNewerFormats(t *testing.T) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, _ := w.Create("cenacle-export.jsonl")
	_, _ = io.WriteString(f, `{"type":"version","version":99}`+"\n")
	_ = w.Close()
	zr, _ := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if _, err := importer.ReadCenacle(zr); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Errorf("err = %v", err)
	}
}

// A reply names a root in another channel: it does not join that thread. A
// file larger than the server allows is left out.
func TestImportKeepsThreadsAndFilesInBounds(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := dirFiles(t)
	files.MaxSize = 8
	at := time.Unix(1600000000, 0)
	fileKey := guuid.NewString()
	d := importer.Data{
		Source: "cenacle",
		Users: []importer.User{
			{Key: "a", Email: "a@example.com", DisplayName: "A"}, {Key: "b", Email: "b@example.com", DisplayName: "B"},
		},
		Channels: []importer.Channel{
			{Key: "secret", Workspace: "W", Name: "secret", Private: true, Members: []string{"a"}},
			{Key: "open", Workspace: "W", Name: "open", Members: []string{"a", "b"}},
		},
		Messages: []importer.Message{
			{Key: "root", Channel: "secret", Author: "a", Body: "private thread", At: at},
			{Key: "reply", Channel: "open", Author: "b", Body: "reply", Root: "root", At: at.Add(time.Second),
				Files: []importer.File{{Key: fileKey, Name: "big.txt", ContentType: "text/plain", Size: 9}}},
		},
		OpenFile: func(string) (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("123456789")), nil },
	}
	if _, err := importer.Import(ctx, pool, d, log, files, importer.Options{}); err != nil {
		t.Fatal(err)
	}
	var root pgtype.UUID
	if err := pool.QueryRow(ctx, "SELECT root_id FROM messages WHERE body = 'reply'").Scan(&root); err != nil || root.Valid {
		t.Errorf("the reply joined a thread of another channel: %v %v", root, err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM files").Scan(&n); err != nil || n != 0 {
		t.Errorf("files = %d, %v", n, err)
	}
	if err := files.Ingest(ctx, store.New(pool), store.File{Size: 9}, strings.NewReader("123456789")); !errors.Is(err, chat.ErrIngestTooLarge) {
		t.Errorf("ingest a large file = %v", err)
	}
}
