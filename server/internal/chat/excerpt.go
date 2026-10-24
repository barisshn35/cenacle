// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// foldRune folds a letter as search does (cenacle_search_vector): lower case,
// the Turkish i's alike, accents removed.
func foldRune(r rune) rune {
	switch r {
	case 'İ', 'I', 'ı':
		return 'i'
	}
	r = unicode.ToLower(r)
	if d := norm.NFD.String(string(r)); d != "" {
		return []rune(d)[0]
	}
	return r
}

// excerptTerms are the words of a search that must match (not the "-word" ones), folded.
func excerptTerms(q string) []string {
	var out []string
	for _, w := range strings.Fields(q) {
		if strings.HasPrefix(w, "-") {
			continue
		}
		var b strings.Builder
		for _, r := range w {
			if f := foldRune(r); (f >= 'a' && f <= 'z') || (f >= '0' && f <= '9') {
				b.WriteRune(f)
			}
		}
		if b.Len() > 0 {
			out = append(out, b.String())
		}
	}
	return out
}

// excerpt is the words around the first place where a word of text starts with
// a term of the search, the match between « and » (empty when none is found).
func excerpt(text, q string) string {
	terms := excerptTerms(q)
	if len(terms) == 0 || text == "" {
		return ""
	}
	runes := []rune(text)
	folded := make([]rune, len(runes))
	for i, r := range runes {
		folded[i] = foldRune(r)
	}
	isWord := func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }
	at, length := -1, 0
	for i := 0; i < len(folded) && at < 0; i++ {
		if !isWord(runes[i]) || (i > 0 && isWord(runes[i-1])) {
			continue
		}
		for _, t := range terms {
			tr := []rune(t)
			if i+len(tr) <= len(folded) && string(folded[i:i+len(tr)]) == t {
				// The whole word is marked (search matches word beginnings).
				end := i + len(tr)
				for end < len(runes) && isWord(runes[end]) {
					end++
				}
				at, length = i, end-i
				break
			}
		}
	}
	if at < 0 {
		return ""
	}
	const before, after = 60, 120
	start, end := max(0, at-before), min(len(runes), at+length+after)
	// Start and end at word boundaries.
	for start > 0 && start < at && isWord(runes[start-1]) {
		start++
	}
	for end < len(runes) && end > at+length && isWord(runes[end]) {
		end--
	}
	out := strings.Join(strings.Fields(string(runes[start:at])+"«"+string(runes[at:at+length])+"»"+string(runes[at+length:end])), " ")
	if start > 0 {
		out = "… " + out
	}
	if end < len(runes) {
		out += " …"
	}
	return out
}
