// SPDX-License-Identifier: AGPL-3.0-only

package importer_test

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/Cenacle-TR/cenacle/server/internal/importer"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
	"github.com/Cenacle-TR/cenacle/server/internal/testdb"
)

const mattermostExport = `{"type":"version","version":1}
{"type":"team","team":{"name":"acme","display_name":"ACME Ltd","type":"O"}}
{"type":"channel","channel":{"team":"acme","name":"town-square","display_name":"Town Square","type":"O","purpose":"Everyone"}}
{"type":"channel","channel":{"team":"acme","name":"secret","display_name":"Secret","type":"P"}}
{"type":"user","user":{"username":"ayse","email":"Ayse@Example.com","first_name":"Ayşe","last_name":"Yılmaz","roles":"system_user system_admin","teams":[{"name":"acme","roles":"team_user","channels":[{"name":"town-square","roles":"channel_user"},{"name":"secret","roles":"channel_user channel_admin"}]}]}}
{"type":"user","user":{"username":"mert","email":"mert@example.com","nickname":"Mert","teams":[{"name":"acme","roles":"team_user","channels":[{"name":"town-square","roles":"channel_user"}]}]}}
{"type":"post","post":{"team":"acme","channel":"town-square","user":"mert","message":"Merhaba @ayse, bakar mısın? @here","create_at":1600000060000,"replies":[{"user":"ayse","message":"Tabii","create_at":1600000120000}]}}
{"type":"post","post":{"team":"acme","channel":"town-square","user":"ayse","message":"İlk mesaj","create_at":1600000000000}}
{"type":"post","post":{"team":"acme","channel":"secret","user":"ayse","message":"gizli","create_at":1600000030000}}
{"type":"direct_channel","direct_channel":{"members":["ayse","mert"]}}
{"type":"direct_post","direct_post":{"channel_members":["mert","ayse"],"user":"mert","message":"DM","create_at":1600000200000}}
`

func TestReadMattermost(t *testing.T) {
	d, err := importer.ReadMattermost(strings.NewReader(mattermostExport), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Users) != 2 || d.Users[0].DisplayName != "Ayşe Yılmaz" || !d.Users[0].Admin || d.Users[1].DisplayName != "Mert" {
		t.Errorf("users = %+v", d.Users)
	}
	if len(d.Channels) != 3 || d.Channels[0].Workspace != "ACME Ltd" || d.Channels[0].Topic != "Everyone" ||
		!d.Channels[1].Private || d.Channels[1].Managers[0] != "ayse" || !d.Channels[2].Conversation {
		t.Errorf("channels = %+v", d.Channels)
	}
	if len(d.Messages) != 5 || !strings.Contains(d.Messages[0].Body, importer.Mention("ayse")) ||
		!strings.Contains(d.Messages[0].Body, "@here") {
		t.Errorf("messages = %+v", d.Messages)
	}
}

func slackZip(t *testing.T) *zip.Reader {
	files := map[string]string{
		"users.json": `[{"id":"U1","name":"ayse","profile":{"email":"ayse@example.com","real_name":"Ayşe Yılmaz"},"is_admin":true},
			{"id":"U2","name":"mert","profile":{"email":"mert@example.com","real_name":"Mert Kaya"}},
			{"id":"B1","name":"deploybot","profile":{"real_name":"Deploy Bot"}}]`,
		"channels.json": `[{"id":"C1","name":"general","members":["U1","U2","B1"],"purpose":{"value":"Genel"}}]`,
		"groups.json":   `[{"id":"G1","name":"yonetim","members":["U1"]}]`,
		"dms.json":      `[{"id":"D1","members":["U1","U2"]}]`,
		"general/2020-09-13.json": `[{"type":"message","user":"U2","text":"<@U1> *önemli* ~eski~ &lt;tag&gt; <https://example.com|site> <#C1|general>","ts":"1600000000.000100"},
			{"type":"message","subtype":"channel_join","user":"U2","text":"<@U2> has joined","ts":"1600000001.000000"},
			{"type":"message","user":"B1","text":"deployed","ts":"1600000002.000000"}]`,
		"yonetim/2020-09-13.json": `[{"type":"message","user":"U1","text":"plan","ts":"1600000003.000000"}]`,
		"D1/2020-09-13.json":      `[{"type":"message","user":"U2","text":"selam","ts":"1600000004.000000"}]`,
	}
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, _ := w.Create(name)
		_, _ = io.WriteString(f, body)
	}
	_ = w.Close()
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return zr
}

func TestReadSlack(t *testing.T) {
	d, err := importer.ReadSlack(slackZip(t), "Slack")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Users) != 3 || len(d.Channels) != 3 || len(d.Messages) != 4 {
		t.Fatalf("%d users, %d channels, %d messages", len(d.Users), len(d.Channels), len(d.Messages))
	}
	var first importer.Message
	for _, m := range d.Messages {
		if m.Channel == "C1" && m.Author == "U2" {
			first = m
		}
	}
	want := importer.Mention("U1") + " **önemli** ~~eski~~ <tag> [site](https://example.com) #general"
	if first.Body != want {
		t.Errorf("body = %q\nwant %q", first.Body, want)
	}
}

func TestImportIntoCenacle(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	q := store.New(pool)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Mert already uses Cenacle: the import finds him by his address.
	mert, err := q.UpsertUserFromIdentity(ctx, store.UpsertUserFromIdentityParams{
		AuthService: "cenacle-id", AuthData: "sub-mert", Email: "mert@example.com", EmailVerified: true, DisplayName: "Mert K",
	})
	if err != nil {
		t.Fatal(err)
	}
	d, err := importer.ReadMattermost(strings.NewReader(mattermostExport), "")
	if err != nil {
		t.Fatal(err)
	}
	res, err := importer.Import(ctx, pool, d, log, nil, importer.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Workspaces != 1 || res.Users != 1 || res.Channels != 3 || res.Messages != 5 || res.Skipped != 0 {
		t.Errorf("result = %+v", res)
	}
	// Importing again adds nothing.
	again, err := importer.Import(ctx, pool, d, log, nil, importer.Options{})
	if err != nil || again.Users+again.Channels+again.Messages+again.Workspaces != 0 {
		t.Errorf("again = %+v, %v", again, err)
	}

	ws, err := q.FindWorkspaceByName(ctx, "ACME Ltd")
	if err != nil {
		t.Fatal(err)
	}
	town, err := q.GetChannelByName(ctx, store.GetChannelByNameParams{WorkspaceID: ws.ID, Name: "Town Square"})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := q.ListMessagesBefore(ctx, store.ListMessagesBeforeParams{ChannelID: town.ID, RowLimit: 10})
	if err != nil {
		t.Fatal(err)
	}
	// Newest first, in the original order, with original times.
	if len(rows) != 3 || rows[2].Body != "İlk mesaj" || rows[0].Body != "Tabii" || rows[2].CreatedAt.Unix() != 1600000000 {
		t.Fatalf("messages = %+v", rows)
	}
	if !strings.HasPrefix(rows[1].Body, "Merhaba <@") || rows[1].AuthorID != mert.ID {
		t.Errorf("mention or author = %q %v", rows[1].Body, rows[1].AuthorID)
	}
	// History is read for everyone.
	var unread int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM channel_members m JOIN messages x ON x.channel_id = m.channel_id
		WHERE m.channel_id = $1 AND (m.last_read_id IS NULL OR x.id > m.last_read_id)`, town.ID).Scan(&unread); err != nil || unread != 0 {
		t.Errorf("unread = %d, %v", unread, err)
	}

	// Ayşe signs in with Cenacle ID: she gets the imported account.
	claimed, err := q.ClaimImportedUser(ctx, store.ClaimImportedUserParams{
		AuthService: "cenacle-id", AuthData: "sub-ayse", DisplayName: "Ayşe Y", Email: "AYSE@example.com",
	})
	if err != nil || claimed.AuthData != "sub-ayse" || !claimed.EmailVerified {
		t.Fatalf("claim = %+v, %v", claimed, err)
	}
	if rows[0].AuthorID != claimed.ID {
		t.Error("the claimed account is not the author of her messages")
	}
}

func TestImportSlack(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	d, err := importer.ReadSlack(slackZip(t), "Slack")
	if err != nil {
		t.Fatal(err)
	}
	res, err := importer.Import(ctx, pool, d, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, importer.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Users != 3 || res.Channels != 3 || res.Messages != 4 {
		t.Errorf("result = %+v", res)
	}
	var private string
	if err := pool.QueryRow(ctx, "SELECT visibility FROM channels WHERE name = 'yonetim'").Scan(&private); err != nil || private != "private" {
		t.Errorf("private channel = %q %v", private, err)
	}
}

// An export naming a native workspace and its private channel must not add
// people there or make them administrators unless the operator merges, and
// merging adds them as plain members only.
func TestImportDoesNotJoinNativeChannels(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	q := store.New(pool)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	owner, err := q.UpsertUserFromIdentity(ctx, store.UpsertUserFromIdentityParams{
		AuthService: "cenacle-id", AuthData: "sub-owner", Email: "owner@example.com", EmailVerified: true, DisplayName: "Owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := q.UpsertUserFromIdentity(ctx, store.UpsertUserFromIdentityParams{
		AuthService: "cenacle-id", AuthData: "sub-bob", Email: "bob@else.test", EmailVerified: true, DisplayName: "Bob",
	})
	if err != nil {
		t.Fatal(err)
	}
	ws, err := q.CreateWorkspace(ctx, store.CreateWorkspaceParams{Name: "Ops"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.AddWorkspaceMember(ctx, store.AddWorkspaceMemberParams{WorkspaceID: ws.ID, UserID: owner.ID, Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	secret, err := q.CreateChannel(ctx, store.CreateChannelParams{
		WorkspaceID: ws.ID, Name: "secret", Kind: "standard", Visibility: "private", CreatedBy: owner.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	const export = `{"type":"version","version":1}
{"type":"team","team":{"name":"ops","display_name":"Ops","type":"O"}}
{"type":"channel","channel":{"team":"ops","name":"secret","display_name":"secret","type":"P"}}
{"type":"user","user":{"username":"bob","email":"bob@else.test","roles":"system_user system_admin","teams":[{"name":"ops","roles":"team_user team_admin","channels":[{"name":"secret","roles":"channel_user channel_admin"}]}]}}
{"type":"post","post":{"team":"ops","channel":"secret","user":"bob","message":"planted","create_at":1600000000000}}
`
	d, err := importer.ReadMattermost(strings.NewReader(export), "")
	if err != nil {
		t.Fatal(err)
	}
	membership := func() (wsRole, chRole string, messages int) {
		t.Helper()
		_ = pool.QueryRow(ctx, "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", ws.ID, bob.ID).Scan(&wsRole)
		_ = pool.QueryRow(ctx, "SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2", secret.ID, bob.ID).Scan(&chRole)
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM messages WHERE channel_id = $1", secret.ID).Scan(&messages); err != nil {
			t.Fatal(err)
		}
		return wsRole, chRole, messages
	}

	// Without merging, the import stops before writing anything.
	if _, err := importer.Import(ctx, pool, d, log, nil, importer.Options{}); err == nil ||
		!strings.Contains(err.Error(), `workspace "Ops"`) {
		t.Fatalf("import into a native workspace: %v", err)
	}
	if wsRole, chRole, n := membership(); wsRole != "" || chRole != "" || n != 0 {
		t.Fatalf("without merge: workspace role %q, channel role %q, %d messages", wsRole, chRole, n)
	}

	// Merging: Bob joins as a member, not as an administrator or manager.
	if _, err := importer.Import(ctx, pool, d, log, nil, importer.Options{Merge: true}); err != nil {
		t.Fatal(err)
	}
	if wsRole, chRole, n := membership(); wsRole != "member" || chRole != "member" || n != 1 {
		t.Fatalf("merge: workspace role %q, channel role %q, %d messages", wsRole, chRole, n)
	}
}

// A workspace an earlier import created takes the next import without
// merging; a channel made there natively afterwards does not.
func TestImportAgainIntoImportedWorkspace(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	d, err := importer.ReadMattermost(strings.NewReader(mattermostExport), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := importer.Import(ctx, pool, d, log, nil, importer.Options{}); err != nil {
		t.Fatal(err)
	}
	q := store.New(pool)
	ws, err := q.FindWorkspaceByName(ctx, "ACME Ltd")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.CreateChannel(ctx, store.CreateChannelParams{
		WorkspaceID: ws.ID, Name: "later", Kind: "standard", Visibility: "private",
	}); err != nil {
		t.Fatal(err)
	}
	native := append(d.Channels, importer.Channel{Key: "later", Workspace: "ACME Ltd", Name: "later", Members: []string{"mert"}})
	withNative := d
	withNative.Channels = native
	if _, err := importer.Import(ctx, pool, withNative, log, nil, importer.Options{}); err == nil ||
		!strings.Contains(err.Error(), `channel "later"`) {
		t.Fatalf("import into a native channel of an imported workspace: %v", err)
	}
	if again, err := importer.Import(ctx, pool, d, log, nil, importer.Options{}); err != nil || again.Messages != 0 {
		t.Fatalf("again = %+v, %v", again, err)
	}
}

// An address an account has not verified does not tie an export's person to it.
func TestImportMatchesVerifiedAddressesOnly(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	q := store.New(pool)
	unverified, err := q.UpsertUserFromIdentity(ctx, store.UpsertUserFromIdentityParams{
		AuthService: "cenacle-id", AuthData: "sub-mert", Email: "mert@example.com", DisplayName: "Mert",
	})
	if err != nil {
		t.Fatal(err)
	}
	d, err := importer.ReadMattermost(strings.NewReader(mattermostExport), "")
	if err != nil {
		t.Fatal(err)
	}
	res, err := importer.Import(ctx, pool, d, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, importer.Options{})
	if err != nil || res.Users != 2 {
		t.Fatalf("result = %+v, %v", res, err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM messages WHERE author_id = $1", unverified.ID).Scan(&n); err != nil || n != 0 {
		t.Errorf("messages by the unverified account = %d, %v", n, err)
	}
}
