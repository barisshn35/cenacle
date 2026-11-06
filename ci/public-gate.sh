#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Exits 0 when ci/public-publishing says "open", 1 otherwise (locked, missing
# or anything else), with the reason on stderr. Every CI step that writes to
# GitHub or ghcr.io asks it first (docs/operations/ci.md, "Public publishing").
#
# Usage: ci/public-gate.sh
set -eu
file="$(cd "$(dirname "$0")" && pwd)/public-publishing"
state="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$file" 2>/dev/null | grep -v '^$' | head -n 1 || true)"
if [ "$state" = open ]; then
  exit 0
fi
echo "public publishing is locked (ci/public-publishing: ${state:-missing}): nothing goes to GitHub or ghcr.io" >&2
exit 1
