// SPDX-License-Identifier: AGPL-3.0-only
package importer

import (
	"testing"
	"testing/fstest"
	"unicode/utf8"
)

// Export files come from other systems and may be damaged or made up: the
// readers must answer with an error, never panic. Each fuzz target puts the
// input in one file of an otherwise minimal export.

func mapFS(files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{}
	for name, data := range files {
		fsys[name] = &fstest.MapFile{Data: []byte(data)}
	}
	return fsys
}

func FuzzRocketChat(f *testing.F) {
	f.Add(`{"_id":"m1","rid":"r1","msg":"hi","u":{"_id":"u1","username":"ayse"},"ts":{"$date":"2026-01-01T00:00:00Z"}}`)
	f.Add(`[{"_id":"m1","ts":{"$date":{"$numberLong":"-1"}}}]`)
	f.Fuzz(func(t *testing.T, messages string) {
		_, _ = ReadRocketChat(mapFS(map[string]string{
			"users.json":                   `{"_id":"u1","username":"ayse","emails":[{"address":"a@example.com"}]}`,
			"rocketchat_room.json":         `{"_id":"r1","name":"general","t":"c"}`,
			"rocketchat_subscription.json": `{"rid":"r1","u":{"_id":"u1"}}`,
			"rocketchat_message.json":      messages,
		}), "Acme")
	})
}

func FuzzZulip(f *testing.F) {
	f.Add(`{"zerver_message":[{"id":1,"sender":1,"recipient":1,"content":"hi @**Ayşe|1**","date_sent":1.5}]}`)
	f.Fuzz(func(t *testing.T, messages string) {
		_, _ = ReadZulip(mapFS(map[string]string{
			"realm.json":           `{"zerver_userprofile":[{"id":1,"full_name":"Ayşe","delivery_email":"a@example.com"}],"zerver_stream":[{"id":1,"name":"general"}],"zerver_recipient":[{"id":1,"type":2,"type_id":1}]}`,
			"messages-000001.json": messages,
		}), "Acme")
	})
}

func FuzzDiscord(f *testing.F) {
	f.Add(`{"guild":{"name":"Acme"},"channel":{"id":"1","name":"general"},"messages":[{"id":"2","content":"hi <#1>","author":{"id":"3","name":"ayse"},"timestamp":"2026-01-01T00:00:00Z"}]}`)
	f.Fuzz(func(t *testing.T, channel string) {
		_, _ = ReadDiscord(mapFS(map[string]string{"general.json": channel}), "Acme")
	})
}

func FuzzTeams(f *testing.F) {
	f.Add(`{"value":[{"id":"1","createdDateTime":"2026-01-01T00:00:00Z","from":{"user":{"id":"u1"}},"body":{"contentType":"html","content":"<p>hi <at id=\"0\">Ayşe</at></p>"},"mentions":[{"id":0,"mentioned":{"user":{"id":"u1"}}}]}]}`)
	f.Fuzz(func(t *testing.T, channel string) {
		_, _ = ReadTeams(mapFS(map[string]string{
			"users.json":              `{"value":[{"id":"u1","displayName":"Ayşe","mail":"a@example.com"}]}`,
			"teams/Acme/general.json": channel,
		}), "Acme")
	})
}

func FuzzCenacle(f *testing.F) {
	f.Add("{\"version\":1}\n{\"type\":\"user\",\"id\":\"01a1720a-d27f-759f-bbf7-928ae7367fda\",\"email\":\"a@example.com\"}\n")
	f.Fuzz(func(t *testing.T, manifest string) {
		_, _ = ReadCenacle(mapFS(map[string]string{exportManifest: manifest}))
	})
}

// Teams HTML becomes Markdown text. Text that looks like HTML may stay (as
// anyone can type it); it is shown as text, never rendered.
func FuzzTeamsHTML(f *testing.F) {
	f.Add(`<p>hi <b>there</b> <a href="https://example.com">link</a></p><script>x</script>`, 0)
	f.Add(`<at id="0">Ayşe</at><img src=x onerror=y>`, 1)
	f.Fuzz(func(t *testing.T, html string, id int) {
		out := teamsHTMLToMarkdown(html, map[int]string{id: "u1"})
		if utf8.ValidString(html) && !utf8.ValidString(out) {
			t.Errorf("valid text became invalid UTF-8: %q", out)
		}
	})
}
