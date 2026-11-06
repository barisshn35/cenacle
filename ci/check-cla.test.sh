#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Tests ci/check-cla.sh on throwaway repositories: a commit without sign-off, one
# by an address that has not signed, and one signed off with another address
# fail; a commit signed off by its author, who signed, passes.
#
# Usage: ci/check-cla.test.sh
set -eu
check="$(cd "$(dirname "$0")" && pwd)/check-cla.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

# case NAME WANT(pass|fail) AUTHOR SIGNOFF-LINE
case_() {
  name="$1" want="$2" author="$3" signoff="$4"
  repo="$tmp/$name"
  git init -q "$repo"
  mkdir "$repo/cla"
  printf '# signatures\nsigned@example.com  Signed-Person  2026-11-04  individual\n' > "$repo/cla/signatures.txt"
  git -C "$repo" -c user.name=Base -c user.email=signed@example.com add cla
  git -C "$repo" -c user.name=Base -c user.email=signed@example.com commit -q -m "base" -m "Signed-off-by: Base <signed@example.com>"
  base="$(git -C "$repo" rev-parse HEAD)"
  echo "$name" > "$repo/change.txt"
  git -C "$repo" add change.txt
  if [ -n "$signoff" ]; then
    git -C "$repo" -c user.name=Author -c user.email="$author" commit -q -m "change" -m "$signoff"
  else
    git -C "$repo" -c user.name=Author -c user.email="$author" commit -q -m "change"
  fi
  if (cd "$repo" && sh "$check" "$base" HEAD > "$tmp/$name.out" 2>&1); then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then
    echo "ok   $name ($got)"
  else
    echo "FAIL $name: want $want, got $got"
    sed 's/^/     /' "$tmp/$name.out"
    failures=$((failures + 1))
  fi
}

case_ unsigned fail signed@example.com ""
case_ not-listed fail stranger@example.com "Signed-off-by: Stranger <stranger@example.com>"
case_ other-signoff fail signed@example.com "Signed-off-by: Someone Else <other@example.com>"
case_ correct pass signed@example.com "Signed-off-by: Signed Person <signed@example.com>"
case_ correct-case pass Signed@Example.com "Signed-off-by: Signed Person <signed@EXAMPLE.com>"

[ "$failures" -eq 0 ] || exit 1
echo "check-cla.sh: all cases as expected"
