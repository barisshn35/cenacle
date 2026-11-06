// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Cenacle-TR/cenacle/server/internal/api"
	"github.com/Cenacle-TR/cenacle/server/internal/store"
)

// The parsers below take what people type. Their seeds run with every test;
// `go test -fuzz=Fuzz<Name> ./internal/chat` looks further.

var termsRE = regexp.MustCompile(`^('[\p{L}\p{N}]+':\*)( \| '[\p{L}\p{N}]+':\*)*$`)

// FuzzSearchTerms: questions become OR searches of words that PostgreSQL
// always parses (a syntax error would fail the request).
func FuzzSearchTerms(f *testing.F) {
	for _, s := range []string{"When do we ship?", "a & b | !c", "'; DROP TABLE x; --", "çğıöşü İstanbul", `\:*'`, ""} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, q string) {
		terms := searchTerms(q)
		if terms != "" && !termsRE.MatchString(terms) {
			t.Fatalf("searchTerms(%q) = %q", q, terms)
		}
	})
}

// FuzzMentionsAsNames: no mention token (an id) survives; text stays valid.
func FuzzMentionsAsNames(f *testing.F) {
	f.Add("hi <@01a15e50-aaaa-7000-8000-000000000001> and <@zz>", "Ayşe")
	f.Add("<@<@01a15e50-aaaa-7000-8000-000000000001>>", "")
	f.Fuzz(func(t *testing.T, body, name string) {
		people := []api.Person{{DisplayName: name}}
		out := mentionsAsNames(body, people)
		if mentionTokenRE.MatchString(out) && !mentionTokenRE.MatchString(name) {
			t.Fatalf("mention left in %q", out)
		}
		if utf8.ValidString(body) && utf8.ValidString(name) && !utf8.ValidString(out) {
			t.Fatalf("invalid text from %q", body)
		}
	})
}

// FuzzEnvelopes: only well-formed envelopes count as encrypted bodies, and a
// plain channel never takes one.
func FuzzEnvelopes(f *testing.F) {
	f.Add("e2e:v1:AAAAAAAAAAAAAAAA:QUJDREVGR0hJSktMTU5PUFFSU1RVVldY")
	f.Add("e2e:v1::")
	f.Add("e2e:v1:AAAAAAAAAAAAAAAA:QUJD\nREVG")
	f.Fuzz(func(t *testing.T, body string) {
		if isEnvelope(body) && (strings.ContainsAny(body, " \n<>") || len(body) > 12000) {
			t.Fatalf("isEnvelope(%q)", body)
		}
		if strings.HasPrefix(body, "e2e:v1:") && encryptedBody(storeChannel(false), body) {
			t.Fatalf("plain channel took %q", body)
		}
	})
}

// FuzzMLSHeader: any envelope reads safely; a header read is inside it.
func FuzzMLSHeader(f *testing.F) {
	f.Add("mls:v1:AAEAAiRhYmNkZWZnaC0xMjM0LTEyMzQtMTIzNC0xMjM0NTY3ODlhYmMAAAAAAAAAA6urq6s=")
	f.Add("mls:v1:AAEAAv8=")
	f.Add("mls:v1:AAEAAoA=")
	f.Fuzz(func(t *testing.T, body string) {
		group, _, ok := mlsHeader(body)
		if ok && len(group) > len(body) {
			t.Fatalf("group of %d bytes from %q", len(group), body)
		}
		if strings.HasPrefix(body, "mls:v1:") && encryptedBody(storeChannel(false), body) {
			t.Fatalf("plain channel took %q", body)
		}
	})
}

// FuzzFirstLink: a link found is an http(s) address.
func FuzzFirstLink(f *testing.F) {
	f.Add("see https://example.org/a?b=c and http://x")
	f.Add("javascript:alert(1) https://")
	f.Fuzz(func(t *testing.T, body string) {
		link := firstLink(body)
		if link == "" {
			return
		}
		u, err := url.Parse(link)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			t.Fatalf("firstLink(%q) = %q", body, link)
		}
	})
}

// FuzzReminder: whatever is typed, a reminder is in the future and has text.
func FuzzReminder(f *testing.F) {
	for _, s := range []string{"me in 10m stand up", "tomorrow 9:00 call", "10 dk sonra çay", "at 25:99 x", "in -5m x"} {
		f.Add(s)
	}
	now := time.Date(2026, 10, 22, 14, 0, 0, 0, time.UTC)
	f.Fuzz(func(t *testing.T, input string) {
		when, text, ok := parseReminder(input, now, time.UTC)
		if ok && (!when.After(now) || strings.TrimSpace(text) == "") {
			t.Fatalf("parseReminder(%q) = %v %q", input, when, text)
		}
	})
}

func storeChannel(encrypted bool) store.Channel { return store.Channel{Encrypted: encrypted} }

// FuzzPageMeta: fetched pages are untrusted HTML. The preview's texts stay
// storable and its image is an http(s) address, whatever the page holds.
func FuzzPageMeta(f *testing.F) {
	for _, s := range []string{
		`<html><head><title>Plain</title><meta property="og:title" content="OG\x00 title"><meta property="og:image" content="javascript:alert(1)"></head><body>x</body></html>`,
		`<meta name="description" content="` + strings.Repeat("long ", 2000) + `"><meta property="og:image" content="/img.png">`,
		`<head><meta property="og:image" content="//evil.example/x.png"><title>a</title><title>b</title>`,
		"\xff\xfe<title>\xc3\x28</title>", "",
	} {
		f.Add([]byte(s))
	}
	base, _ := url.Parse("https://news.example.com/a/b")
	f.Fuzz(func(t *testing.T, page []byte) {
		m := pageMeta(page, base)
		for _, s := range []string{m.title, m.description, m.site} {
			if !utf8.ValidString(s) || strings.IndexByte(s, 0) >= 0 {
				t.Fatalf("not storable: %q", s)
			}
		}
		if m.image != "" {
			u, err := url.Parse(m.image)
			if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
				t.Fatalf("image %q", m.image)
			}
		}
	})
}
