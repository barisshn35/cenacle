// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"encoding/json"
	"testing"

	"github.com/barisshn35/cenacle/server/internal/store"
)

func automodRule(t *testing.T, kind string, cfg automodConfig) store.AutomodRule {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return store.AutomodRule{Kind: kind, Config: raw}
}

// Keyword rules read the text as the client shows it: markdown emphasis,
// character references, invisible characters and escapes hide nothing.
func TestAutomodKeywordsMatchRenderedText(t *testing.T) {
	rule := automodRule(t, "keywords", automodConfig{Words: []string{"forbidden", "free money", "spam*"}})
	for _, body := range []string{
		"forbidden",
		"say _forbidden_ now",
		"**__forbidden__**",
		"_forbidden_", // /me forbidden
		"forbi&#100;den",
		"forbi&#x64;den",
		"forbid\u00adden",
		"forbi\u200bdden",
		"forbi\u2060dden",
		"ｆｏｒｂｉｄｄｅｎ",
		`\_forbidden\_`,
		"FORBİDDEN",
		"get *free* money",
		"spammer here",
		"~~forbidden~~",
	} {
		if !automodMatch(rule, body) {
			t.Errorf("%q passes the rule", body)
		}
	}
	for _, body := range []string{"for bidden", "forbiddenness", "a snake_case name", "money free", "sp am"} {
		if automodMatch(rule, body) {
			t.Errorf("%q matches the rule", body)
		}
	}
	// A keyword written with an underscore still matches the same text.
	snake := automodRule(t, "keywords", automodConfig{Words: []string{"snake_case"}})
	if !automodMatch(snake, "use snake_case here") || !automodMatch(snake, "use _snake_ case") {
		t.Error("a keyword with an underscore does not match")
	}
}

// Links rules see every link the client renders as clickable.
func TestAutomodLinksMatchRenderedLinks(t *testing.T) {
	rule := automodRule(t, "links", automodConfig{AllowedDomains: []string{"example.com"}})
	for _, body := range []string{
		"https://evil.test/x",
		"www.evil.test/x",
		"see WWW.evil.test",
		"(www.evil.test)",
		"[x](//evil.test/x)",
		"[x]( <//evil.test/x>)",
		"[x]: //evil.test/x",
		"[x](h&#116;tps://evil.test/x)",
		"[x](https&#58;//evil.test/x)",
		`[x](https:\/\/evil.test/x)`,
		`https\://evil.test`,
		`[x](https:\\evil.test)`,
		"[x](https:evil.test)",
		"https://example.com@evil.test/",
		"https://evil%2Etest/",
		"https://evil.test:8443/",
		"h\u200bttps://evil.test",
	} {
		if !automodMatch(rule, body) {
			t.Errorf("%q passes the rule", body)
		}
	}
	for _, body := range []string{
		"https://example.com/ok",
		"https://docs.example.com/a.",
		"www.example.com, then",
		"a // comment and a/b//c",
		"no link here",
		"[x](/relative/path)",
		"https://example.com:443/x",
	} {
		if automodMatch(rule, body) {
			t.Errorf("%q matches the rule", body)
		}
	}
}
