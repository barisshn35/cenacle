// SPDX-License-Identifier: AGPL-3.0-only

package health

import (
	"slices"
	"strings"
)

func joinSorted(names []string) string {
	s := slices.Clone(names)
	slices.Sort(s)
	return strings.Join(s, ", ")
}
