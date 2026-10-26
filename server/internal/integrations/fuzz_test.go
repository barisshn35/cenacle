// SPDX-License-Identifier: AGPL-3.0-only

package integrations_test

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/barisshn35/cenacle/server/internal/api"
	"github.com/barisshn35/cenacle/server/internal/integrations/alertmanager"
	"github.com/barisshn35/cenacle/server/internal/integrations/email"
	"github.com/barisshn35/cenacle/server/internal/integrations/feeds"
	"github.com/barisshn35/cenacle/server/internal/integrations/github"
	"github.com/barisshn35/cenacle/server/internal/integrations/gitlab"
	"github.com/barisshn35/cenacle/server/internal/integrations/jira"
	"github.com/barisshn35/cenacle/server/internal/integrations/signing"
)

// What other services send (webhook bodies, mail, feeds) becomes a card. Any
// body may be refused, none may crash the server, and a card's text must be
// storable: valid UTF-8 without NUL (PostgreSQL stores neither). The seeds
// run with every test; `go test -fuzz=Fuzz<Name> ./internal/integrations`
// looks further.

func storable(t *testing.T, what, s string) {
	t.Helper()
	if !utf8.ValidString(s) || strings.IndexByte(s, 0) >= 0 {
		t.Fatalf("%s is not storable text: %q", what, s)
	}
}

func checkCard(t *testing.T, card api.Attachment) {
	t.Helper()
	for what, s := range map[string]*string{"title": card.Title, "text": card.Text, "footer": card.Footer, "title link": card.TitleLink} {
		if s != nil {
			storable(t, what, *s)
		}
	}
	if card.Fields != nil {
		for _, f := range *card.Fields {
			storable(t, "field title", f.Title)
			storable(t, "field value", f.Value)
		}
	}
	if card.TitleLink != nil && *card.TitleLink != "" &&
		!strings.HasPrefix(*card.TitleLink, "https://") && !strings.HasPrefix(*card.TitleLink, "http://") {
		t.Fatalf("title link is not http(s): %q", *card.TitleLink)
	}
}

func cardFuzz(f *testing.F, seeds []string, card func([]byte) (api.Attachment, bool, error)) {
	for _, s := range seeds {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		c, ok, err := card(body)
		if err == nil && ok {
			checkCard(t, c)
		}
	})
}

func FuzzJira(f *testing.F) {
	cardFuzz(f, []string{
		`{"webhookEvent":"jira:issue_created","issue":{"key":"OPS-1","self":"https://jira.example.com/rest/api/2/issue/1","fields":{"summary":"Disk \u0000 full","status":{"name":"Open"}}},"user":{"displayName":"Ayşe"}}`,
		`{"webhookEvent":"comment_created","comment":{"body":"x"}}`, `{}`, `null`,
	}, jira.Card)
}

func FuzzGitLab(f *testing.F) {
	cardFuzz(f, []string{
		`{"object_kind":"push","ref":"refs/heads/main","user_name":"Mert","project":{"name":"api","web_url":"https://git.example.com/api"},"commits":[{"id":"abc","message":"fix\u0000","url":"javascript:alert(1)"}]}`,
		`{"object_kind":"merge_request","object_attributes":{"title":"Feature","url":"https://git.example.com/mr/1","action":"open"}}`,
		`{"object_kind":"pipeline","object_attributes":{"status":"failed"}}`, `[]`,
	}, gitlab.Card)
}

func FuzzGitHub(f *testing.F) {
	for _, kind := range []string{"push", "pull_request", "issues", "release", "workflow_run", "ping", "x"} {
		f.Add(kind, []byte(`{"action":"opened","repository":{"full_name":"o/r","html_url":"https://github.com/o/r"},"pull_request":{"title":"T\u0000","html_url":"https://github.com/o/r/pull/1"},"sender":{"login":"m"}}`))
	}
	f.Fuzz(func(t *testing.T, kind string, body []byte) {
		c, ok, err := github.Card(kind, body)
		if err == nil && ok {
			checkCard(t, c)
		}
	})
}

func FuzzAlertmanager(f *testing.F) {
	cardFuzz(f, []string{
		`{"status":"firing","alerts":[{"status":"firing","labels":{"alertname":"Disk\u0000","severity":"critical"},"annotations":{"summary":"90%"},"generatorURL":"http://prom:9090/graph"}]}`,
		`{"status":"resolved","alerts":[]}`, `{"alerts":null}`,
	}, alertmanager.Card)
}

func FuzzEmail(f *testing.F) {
	cardFuzz(f, []string{
		"From: Ayşe <a@example.com>\r\nSubject: =?UTF-8?B?w4fEn8SxIMO2xZ/DvA==?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\x00 there",
		"Subject: multi\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>Hi=00</p>\r\n--b--\r\n",
		"Content-Type: multipart/mixed; boundary=a\r\n\r\n--a\r\nContent-Type: multipart/mixed; boundary=a\r\n\r\n--a--",
		"", "garbage",
	}, email.Card)
}

func FuzzFeeds(f *testing.F) {
	for _, s := range []string{
		`<rss version="2.0"><channel><title>News&#0;</title><item><title>One</title><link>https://example.com/1</link></item></channel></rss>`,
		`<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>E</title><link href="javascript:x"/></entry></feed>`,
		`<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><rss><channel><title>&b;</title></channel></rss>`,
		``, `<rss>`,
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		feed, err := feeds.Parse(raw)
		if err != nil {
			return
		}
		storable(t, "feed title", feed.Title)
		for _, it := range feed.Items {
			storable(t, "item title", it.Title)
			storable(t, "item link", it.Link)
			storable(t, "item summary", it.Summary)
		}
	})
}

func FuzzSigningVerify(f *testing.F) {
	now := time.Unix(1_790_000_000, 0)
	f.Add(signing.Sign("secret", now, []byte("body")), []byte("body"))
	f.Add("t=1,v1=00", []byte(""))
	f.Add("t=-99999999999999999999,v1=", []byte("x"))
	f.Fuzz(func(t *testing.T, header string, body []byte) {
		_ = signing.Verify("secret", header, body, now, 5*time.Minute) // any header: no crash
		if !signing.Verify("secret", signing.Sign("secret", now, body), body, now, 5*time.Minute) {
			t.Fatal("a real signature does not verify")
		}
	})
}
