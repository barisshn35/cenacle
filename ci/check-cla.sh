#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Checks the commits of a merge request (GitLab) or pull request (GitHub): each
# is signed off (DCO) by its author, i.e. a Signed-off-by line carries the
# author's e-mail address, and the author has signed the Contributor License
# Agreement (CLA.md): that address is listed in cla/signatures.txt (on the
# target branch or added by this merge request).
#
# Usage: ci/check-cla.sh <base-sha> [<head>]
set -eu

base="$1"
head="${2:-HEAD}"
list="cla/signatures.txt"

signed() {
  # Columns: e-mail, name, date, kind (individual | corporate:<organization>).
  grep -v '^#' "$list" | awk '{print tolower($1)}' | grep -qxF "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
}

status=0
for c in $(git rev-list --no-merges "$base..$head"); do
  email="$(git log -1 --format=%ae "$c")"
  subject="$(git log -1 --format=%s "$c")"
  if ! git log -1 --format=%B "$c" | grep -q "^Signed-off-by: "; then
    echo "✗ $c \"$subject\": no Signed-off-by line (git commit -s; see CONTRIBUTING.md)."
    status=1
  elif ! git log -1 --format=%B "$c" | sed -n 's/^Signed-off-by: .*<\(.*\)>[[:space:]]*$/\1/p' |
    tr '[:upper:]' '[:lower:]' | grep -qxF "$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"; then
    echo "✗ $c \"$subject\": no Signed-off-by line with the author's address $email (git commit -s)."
    status=1
  fi
  if ! signed "$email"; then
    echo "✗ $c \"$subject\": $email has not signed the CLA (CLA.md; add yourself to $list)."
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "✓ Every commit is signed off by its author, who signed the CLA."
exit "$status"
