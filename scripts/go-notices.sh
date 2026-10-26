#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Writes the third-party notices of a Go program: the modules its packages
# come from (and Go's own standard library), each with its license and NOTICE
# files. Run in the module's directory, with its modules downloaded:
#   scripts/go-notices.sh ./cmd/server "Cenacle server" > THIRD_PARTY_NOTICES.txt
set -eu
pkg=${1:?package}
title=${2:?title}
rule==============================================================================

mods=$(go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}} {{.Dir}}{{end}}{{end}}' "$pkg" | sort -u)
count=$(printf '%s\n' "$mods" | grep -c . || true)

printf '%s\n\nThis software includes the Go standard library and the following third-party\nmodules (%s). Their licenses and notices follow.\n' "Third-party notices of $title" "$count"

section() { # name, directory
  printf '\n%s\n%s\n%s\n\n' "$rule" "$1" "$rule"
  found=
  for f in "$2"/LICENSE* "$2"/LICENCE* "$2"/COPYING* "$2"/NOTICE* "$2"/license* "$2"/notice*; do
    [ -f "$f" ] || continue
    cat "$f"
    printf '\n'
    found=1
  done
  [ -n "$found" ] || printf 'The module ships no license file at its root; see its source.\n'
}

section "Go $(go env GOVERSION) (standard library and runtime)" "$(go env GOROOT)"
printf '%s\n' "$mods" | while read -r path version dir; do
  [ -n "$path" ] || continue
  section "$path $version" "$dir"
done
