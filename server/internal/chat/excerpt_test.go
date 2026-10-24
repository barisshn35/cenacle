// SPDX-License-Identifier: AGPL-3.0-only

package chat

import "testing"

func TestExcerpt(t *testing.T) {
	for _, c := range []struct{ text, q, want string }{
		{"Bütçe toplantısı perşembe günü.", "butce", "«Bütçe» toplantısı perşembe günü."},
		{"İstanbul'da buluşalım", "istanbul", "«İstanbul»'da buluşalım"},
		{"Gündem: zeytinyağı fiyatları.", "ZEYTİNYAĞI -fiyat", "Gündem: «zeytinyağı» fiyatları."},
		{"nothing here", "absent", ""},
		{"sayfa çeyrek", "ey", ""}, // word beginnings only
	} {
		if got := excerpt(c.text, c.q); got != c.want {
			t.Errorf("excerpt(%q, %q) = %q, want %q", c.text, c.q, got, c.want)
		}
	}
}
