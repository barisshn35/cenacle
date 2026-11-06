#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Tests the public publishing lock and ci/mirror.sh on throwaway repositories:
# while locked (or the lock file is missing or unreadable) nothing is pushed
# even with a token; when open, --dry-run pushes nothing, a push sends each
# folder's own history to main, a later push fast-forwards and a v* tag goes
# as a tag; a shallow clone is refused. Also checks that every step of
# .gitlab-ci.yml that writes to ghcr.io asks the gate.
#
# Usage: ci/mirror.test.sh
set -eu
ci="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }

git_() { git -c user.name=Test -c user.email=test@example.com "$@"; }

# A repository with every mirrored folder and a copy of the CI scripts.
repo="$tmp/repo"
git init -q -b main "$repo"
mkdir -p "$repo/ci"
cp "$ci/mirror.sh" "$ci/public-gate.sh" "$ci/mirrors.txt" "$repo/ci/"
grep -v -e '^#' -e '^[[:space:]]*$' "$ci/mirrors.txt" | while read -r folder _; do
  mkdir -p "$repo/$folder" && echo "$folder" > "$repo/$folder/README.md"
done
printf 'locked\n' > "$repo/ci/public-publishing"
git_ -C "$repo" add -A && git_ -C "$repo" commit -q -m one

targets="$tmp/targets"
mkdir -p "$targets"
grep -v -e '^#' -e '^[[:space:]]*$' "$ci/mirrors.txt" | while read -r _ name; do
  git init -q --bare "$targets/$name.git"
done
refs() { for t in "$targets"/*.git; do git -C "$t" for-each-ref --format='%(refname)'; done | sort | uniq -c | tr -s ' '; }
run() { (cd "$repo" && env -u CI_COMMIT_TAG -u CI_COMMIT_SHA MIRROR_BASE="$targets" GITHUB_MIRROR_TOKEN=test-token "$@" sh ci/mirror.sh "${ARGS:-}") ; }

# Locked: nothing pushed, the job passes.
out="$(run 2>&1)"; code=$?
if [ $code -eq 0 ] && echo "$out" | grep -q locked && [ -z "$(refs)" ]; then ok "locked: nothing pushed"; else bad "locked: $out"; fi

# A v* tag while locked (the 0.99.5 case): nothing pushed.
out="$(run CI_COMMIT_TAG=v0.99.5 2>&1)"
if echo "$out" | grep -q locked && [ -z "$(refs)" ]; then ok "locked tag v0.99.5: nothing pushed"; else bad "locked tag: $out"; fi

# Missing or unknown lock: treated as locked.
for content in "" "opened" "# open"; do
  printf '%s\n' "$content" > "$repo/ci/public-publishing"
  out="$(run 2>&1)"
  if echo "$out" | grep -q locked && [ -z "$(refs)" ]; then ok "lock '$content': locked"; else bad "lock '$content': $out"; fi
done
rm "$repo/ci/public-publishing"
out="$(run 2>&1)"
if echo "$out" | grep -q "locked (ci/public-publishing: missing)" && [ -z "$(refs)" ]; then ok "lock file missing: locked"; else bad "missing: $out"; fi

# Open, dry run: seven lines, nothing pushed.
printf '# test\nopen\n' > "$repo/ci/public-publishing"
out="$(ARGS=--dry-run run 2>&1)"
if [ "$(echo "$out" | grep -c 'would push')" -eq 7 ] && [ -z "$(refs)" ]; then ok "open, dry run: 7 planned, nothing pushed"; else bad "dry run: $out"; fi

# Open: each folder's own history on main.
run >/dev/null 2>&1 || bad "open: push failed"
if [ "$(refs)" = " 7 refs/heads/main" ]; then ok "open: main in all 7"; else bad "open refs: $(refs)"; fi
if [ "$(git -C "$targets/cenacle-helm.git" show main:README.md)" = deploy/helm ]; then ok "folder content at the root"; else bad "content"; fi

# A later commit fast-forwards; a v* tag goes as a tag.
echo two >> "$repo/sdk/go/README.md" && git_ -C "$repo" commit -q -am two
run >/dev/null 2>&1 || bad "second push failed"
if [ "$(git -C "$targets/cenacle-sdk-go.git" rev-list --count main)" -eq 2 ]; then ok "fast-forward"; else bad "fast-forward"; fi
git_ -C "$repo" tag v1.0.0
run CI_COMMIT_TAG=v1.0.0 >/dev/null 2>&1 || bad "tag push failed"
if [ "$(refs | grep -c 'refs/tags/v1.0.0')" -eq 1 ] && [ "$(refs)" = "$(printf ' 7 refs/heads/main\n 7 refs/tags/v1.0.0')" ]; then ok "tag v1.0.0 in all 7"; else bad "tag refs: $(refs)"; fi

# A shallow clone is refused.
git clone -q --depth 1 "file://$repo" "$tmp/shallow"
if out="$(cd "$tmp/shallow" && MIRROR_BASE="$targets" GITHUB_MIRROR_TOKEN=t sh ci/mirror.sh 2>&1)"; then
  bad "shallow clone passed"
elif echo "$out" | grep -q shallow; then
  ok "shallow clone refused"
else
  bad "shallow: $out"
fi

# Every ghcr.io step in .gitlab-ci.yml asks the gate.
if grep -n 'GHCR_TOKEN:-' "$ci/../.gitlab-ci.yml" | grep -v public-gate | grep -q .; then
  bad "a GHCR_TOKEN step does not ask ci/public-gate.sh"
else ok ".gitlab-ci.yml: ghcr.io only through the gate"; fi
if grep -q '^locked$' "$ci/public-publishing"; then ok "this repository: locked"; else bad "this repository's lock is not 'locked'"; fi

[ "$failures" -eq 0 ] || { echo "$failures failure(s)"; exit 1; }
