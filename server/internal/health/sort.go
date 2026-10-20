// SPDX-License-Identifier: Apache-2.0

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
