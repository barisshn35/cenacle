#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Checks the commits of a merge request: each is signed off (DCO) and its
# author has signed the Contributor License Agreement (CLA.md), i.e. their
# e-mail address is listed in cla/signatures.txt (on the target branch or
# added by this merge request).
#
# Usage: ci/check-cla.sh <base-sha> [<head>]
set -eu

base="$1"
head="${2:-HEAD}"
list="cla/signatures.txt"

signed() {
  # Columns: e-mail, name, date, kind (individual | corporate:<organization>).
  grep -v '^#' "$list" | awk '{print tolower($1)}' | grep -qxF "$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
}

status=0
for c in $(git rev-list --no-merges "$base..$head"); do
  email="$(git log -1 --format=%ae "$c")"
  subject="$(git log -1 --format=%s "$c")"
  if ! git log -1 --format=%B "$c" | grep -q "^Signed-off-by: "; then
    echo "✗ $c \"$subject\": no Signed-off-by line (git commit -s; see CONTRIBUTING.md)."
    status=1
  fi
  if ! signed "$email"; then
    echo "✗ $c \"$subject\": $email has not signed the CLA (CLA.md; add yourself to $list)."
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "✓ Every commit is signed off by someone who signed the CLA."
exit "$status"
