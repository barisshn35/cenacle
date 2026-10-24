// SPDX-License-Identifier: AGPL-3.0-only

package importer_test

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/barisshn35/cenacle/server/internal/importer"
)

func file(s string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(s)} }

func TestReadRocketChat(t *testing.T) {
	fsys := fstest.MapFS{
		"dump/rocketchat.users.json": file(`{"_id":"u1","username":"ayse","name":"Ayşe Yılmaz","roles":["user","admin"],"emails":[{"address":"ayse@example.com"}]}
{"_id":"u2","username":"mert","name":"Mert","emails":[{"address":"mert@example.com"}]}`),
		"dump/rocketchat_room.json": file(`[{"_id":"r1","t":"c","name":"general","topic":"Genel"},
			{"_id":"r2","t":"p","name":"yonetim"},
			{"_id":"r3","t":"d","usernames":["ayse","mert"]},
			{"_id":"r4","t":"l","name":"livechat"}]`),
		"dump/rocketchat_subscription.json": file(`{"rid":"r1","u":{"_id":"u1"},"roles":["owner"]}
{"rid":"r1","u":{"_id":"u2"}}
{"rid":"r2","u":{"_id":"u1"}}`),
		"dump/rocketchat_message.json": file(`{"_id":"m1","rid":"r1","msg":"Merhaba @ayse ve @all","ts":{"$date":"2024-01-02T10:00:00.000Z"},"u":{"_id":"u2"}}
{"_id":"m2","rid":"r1","t":"uj","msg":"mert","ts":{"$date":{"$numberLong":"1704189600000"}},"u":{"_id":"u2"}}
{"_id":"m3","rid":"r3","msg":"DM","ts":{"$date":1704189700000},"u":{"_id":"u1"}}`),
	}
	d, err := importer.ReadRocketChat(fsys, "Acme")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Users) != 2 || !d.Users[0].Admin || d.Users[0].Email != "ayse@example.com" {
		t.Errorf("users = %+v", d.Users)
	}
	if len(d.Channels) != 3 || d.Channels[0].Topic != "Genel" || d.Channels[0].Managers[0] != "u1" ||
		!d.Channels[1].Private || !d.Channels[2].Conversation || d.Channels[2].Members[1] != "u2" {
		t.Errorf("channels = %+v", d.Channels)
	}
	if len(d.Messages) != 2 || !strings.Contains(d.Messages[0].Body, importer.Mention("u1")) ||
		!strings.Contains(d.Messages[0].Body, "@all") || d.Messages[1].At.UnixMilli() != 1704189700000 {
		t.Errorf("messages = %+v", d.Messages)
	}
	if _, err := importer.ReadRocketChat(fstest.MapFS{}, "Acme"); err == nil {
		t.Error("an empty export was read")
	}
}

const zulipRealm = `{
	"zerver_realm": [{"name": "Acme"}],
	"zerver_userprofile": [
		{"id": 10, "email": "user10@zulip", "delivery_email": "ayse@example.com", "full_name": "Ayşe", "role": 100},
		{"id": 11, "email": "mert@example.com", "full_name": "Mert", "role": 400},
		{"id": 12, "email": "can@example.com", "full_name": "Can", "role": 400}
	],
	"zerver_stream": [{"id": 1, "name": "general", "description": "Genel"}, {"id": 2, "name": "old", "deactivated": true}],
	"zerver_recipient": [
		{"id": 100, "type": 2, "type_id": 1}, {"id": 110, "type": 1, "type_id": 10},
		{"id": 111, "type": 1, "type_id": 11}, {"id": 120, "type": 3, "type_id": 5}
	],
	"zerver_subscription": [
		{"user_profile": 10, "recipient": 100}, {"user_profile": 11, "recipient": 100},
		{"user_profile": 10, "recipient": 120}, {"user_profile": 11, "recipient": 120}, {"user_profile": 12, "recipient": 120}
	]
}`

const zulipMessages = `{"zerver_message": [
	{"id": 2, "sender": 11, "recipient": 100, "subject": "deploy", "content": "Hazır mı @**Ayşe|10**?", "date_sent": 1704189600.5},
	{"id": 3, "sender": 10, "recipient": 100, "subject": "deploy", "content": "Evet @**all**", "date_sent": 1704189700},
	{"id": 4, "sender": 10, "recipient": 111, "content": "DM to Mert", "date_sent": 1704189800},
	{"id": 5, "sender": 11, "recipient": 110, "content": "DM back @**Ayşe**", "date_sent": 1704189900},
	{"id": 6, "sender": 12, "recipient": 120, "content": "group #**general>deploy**", "date_sent": 1704190000}
]}`

func zulipTarball(t *testing.T) string {
	name := filepath.Join(t.TempDir(), "zulip-export.tar.gz")
	f, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, e := range []struct{ name, body string }{
		{"zulip-export-abc/", ""}, {"zulip-export-abc/realm.json", zulipRealm},
		{"zulip-export-abc/messages-000001.json", zulipMessages}, {"../escape.json", "{}"},
	} {
		h := &tar.Header{Name: e.name, Mode: 0o600, Size: int64(len(e.body)), Typeflag: tar.TypeReg}
		if strings.HasSuffix(e.name, "/") {
			h.Typeflag, h.Mode = tar.TypeDir, 0o700
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []interface{ Close() error }{tw, gz, f} {
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return name
}

func TestReadZulip(t *testing.T) {
	fsys, closeExport, err := importer.Open(zulipTarball(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = closeExport() }()
	d, err := importer.ReadZulip(fsys, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Users) != 3 || d.Users[0].Email != "ayse@example.com" || !d.Users[0].Admin || d.Users[1].Admin {
		t.Errorf("users = %+v", d.Users)
	}
	var streams, convs int
	for _, c := range d.Channels {
		if c.Workspace != "Acme" {
			t.Errorf("workspace = %q", c.Workspace)
		}
		if c.Conversation {
			convs++
		} else {
			streams++
		}
	}
	if streams != 1 || convs != 2 {
		t.Errorf("channels = %+v", d.Channels)
	}
	m := d.Messages
	if len(m) != 5 || !strings.HasPrefix(m[0].Body, "**deploy**") || strings.HasPrefix(m[1].Body, "**deploy**") ||
		!strings.Contains(m[0].Body, importer.Mention("10")) || !strings.Contains(m[1].Body, "@all") ||
		m[2].Channel != m[3].Channel || !strings.Contains(m[3].Body, importer.Mention("10")) ||
		!strings.Contains(m[4].Body, "#general") || m[0].At.UnixMilli() != 1704189600500 {
		t.Errorf("messages = %+v", m)
	}
}

func TestReadDiscord(t *testing.T) {
	fsys := fstest.MapFS{
		"Acme - general.json": file(`{"guild":{"id":"g1","name":"Acme"},"channel":{"id":"c1","type":"GuildTextChat","name":"general","topic":"Genel"},
			"messages":[
				{"id":"1","type":"Default","timestamp":"2024-01-02T10:00:00+00:00","content":"Selam <@!2> <#c2> <:party:123> @everyone","author":{"id":"1","name":"ayse","nickname":"Ayşe"},"mentions":[{"id":"2","name":"mert"}]},
				{"id":"2","type":"GuildMemberJoin","timestamp":"2024-01-02T10:01:00+00:00","content":"","author":{"id":"3","name":"can"}},
				{"id":"3","type":"Reply","timestamp":"2024-01-02T10:02:00+00:00","content":"Dosya","author":{"id":"2","name":"mert"},"attachments":[{"url":"https://cdn.example/a.png","fileName":"a.png"}]}
			]}`),
		"Acme - dev.json": file(`{"guild":{"id":"g1","name":"Acme"},"channel":{"id":"c2","type":"GuildTextChat","name":"dev"},"messages":[]}`),
		"dm.json": file(`{"guild":{"id":"0","name":"Direct Messages"},"channel":{"id":"d1","type":"DirectTextChat","name":"mert"},
			"messages":[{"id":"9","type":"Default","timestamp":"2024-01-03T10:00:00Z","content":"DM","author":{"id":"1","name":"ayse"}}]}`),
		"other.json": file(`{"not":"discord"}`),
	}
	d, err := importer.ReadDiscord(fsys, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Users) != 2 || d.Users[0].DisplayName != "Ayşe" || d.Users[0].Email != "" {
		t.Errorf("users = %+v", d.Users)
	}
	byKey := map[string]importer.Channel{}
	for _, c := range d.Channels {
		byKey[c.Key] = c
	}
	if len(d.Channels) != 3 || byKey["d1"].Workspace != "Acme" || !byKey["d1"].Conversation ||
		len(byKey["c1"].Members) != 2 || byKey["c1"].Topic != "Genel" {
		t.Errorf("channels = %+v", d.Channels)
	}
	body := d.Messages[0].Body
	if len(d.Messages) != 3 || !strings.Contains(body, importer.Mention("2")) || !strings.Contains(body, "#dev") ||
		!strings.Contains(body, ":party:") || !strings.Contains(body, "@all") ||
		!strings.Contains(d.Messages[1].Body, "[a.png](https://cdn.example/a.png)") {
		t.Errorf("messages = %+v", d.Messages)
	}
}

func TestReadTeams(t *testing.T) {
	fsys := fstest.MapFS{
		"export/users.json": file(`{"value":[{"id":"a1","displayName":"Ayşe","mail":"ayse@example.com"},{"id":"a2","displayName":"Mert","userPrincipalName":"mert@example.com"}]}`),
		"export/teams/Acme/General.json": file(`{"value":[{"id":"1","messageType":"message","createdDateTime":"2024-01-02T10:00:00Z",
			"from":{"user":{"id":"a1","displayName":"Ayşe"}},"subject":"Plan",
			"body":{"contentType":"html","content":"<p>Merhaba <at id=\"0\">Mert</at>, <b>önemli</b> &amp; <a href=\"https://example.com\">link</a></p><pre><code>x &lt; 1</code></pre>"},
			"mentions":[{"id":0,"mentioned":{"user":{"id":"a2","displayName":"Mert"}}}],
			"replies":[{"id":"2","messageType":"message","createdDateTime":"2024-01-02T10:05:00Z","from":{"user":{"id":"a2"}},"body":{"contentType":"text","content":"Tamam"}}]},
			{"id":"3","messageType":"systemEventMessage","createdDateTime":"2024-01-02T10:06:00Z","body":{"content":""}},
			{"id":"4","messageType":"message","createdDateTime":"2024-01-02T10:07:00Z","deletedDateTime":"2024-01-02T10:08:00Z","from":{"user":{"id":"a2"}},"body":{"content":"x"}}]}`),
		"export/chats/19-abc.json": file(`[{"id":"5","messageType":"message","createdDateTime":"2024-01-03T10:00:00Z","from":{"user":{"id":"a2"}},"body":{"contentType":"text","content":"DM"}},
			{"id":"6","messageType":"message","createdDateTime":"2024-01-03T10:01:00Z","from":{"user":{"id":"a1"}},"body":{"contentType":"text","content":"DM 2"}}]`),
	}
	d, err := importer.ReadTeams(fsys, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Users) != 2 || d.Users[1].Email != "mert@example.com" {
		t.Errorf("users = %+v", d.Users)
	}
	if len(d.Channels) != 2 || d.Channels[0].Workspace != "Acme" || d.Channels[0].Name != "General" ||
		!d.Channels[1].Conversation || d.Channels[1].Workspace != "Acme" || len(d.Channels[1].Members) != 2 {
		t.Errorf("channels = %+v", d.Channels)
	}
	want := "**Plan**\n\nMerhaba " + importer.Mention("a2") + ", **önemli** & [link](https://example.com)\n\n```\nx < 1\n```"
	if len(d.Messages) != 4 || d.Messages[1].Body != want || d.Messages[0].Body != "Tamam" {
		t.Errorf("messages = %+v", d.Messages)
	}
	if !d.Messages[0].At.Equal(time.Date(2024, 1, 2, 10, 5, 0, 0, time.UTC)) {
		t.Errorf("reply time = %v", d.Messages[0].At)
	}
}
