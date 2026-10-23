// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"slices"
	"testing"
)

func TestGroupHandles(t *testing.T) {
	for body, want := range map[string][]string{
		"@Backend please, and @design.":     {"backend", "design"},
		"a@b.com and <@0199a7a0-0000-7000>": nil,
		"@here @channel @backend @backend":  {"backend"},
		"(@ops-team) ok":                    {"ops-team"},
		"@@x":                               nil,
	} {
		if got := groupHandles(body); !slices.Equal(got, want) {
			t.Errorf("groupHandles(%q) = %v, want %v", body, got, want)
		}
	}
}
