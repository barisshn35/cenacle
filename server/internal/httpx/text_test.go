// SPDX-License-Identifier: AGPL-3.0-only

package httpx

import "testing"

func TestHasNUL(t *testing.T) {
	type inner struct{ Name string }
	text := "a\x00b"
	cases := []struct {
		v    any
		want bool
	}{
		{struct{ A string }{"plain"}, false},
		{struct{ A string }{text}, true},
		{&struct{ P *string }{&text}, true},
		{struct{ L []inner }{[]inner{{"x"}, {text}}}, true},
		{map[string]string{"k": text}, true},
		{map[string]string{text: "v"}, true},
		{struct{ B []byte }{[]byte{0}}, false},
		{struct{ hidden string }{text}, false},
		{struct{ Any any }{map[string]any{"deep": []any{text}}}, true},
		{nil, false},
	}
	for i, c := range cases {
		if got := HasNUL(c.v); got != c.want {
			t.Errorf("case %d: HasNUL(%#v) = %v, want %v", i, c.v, got, c.want)
		}
	}
}
