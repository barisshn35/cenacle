#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Builds makemsix from Microsoft's msix-packaging (MIT) with packing turned on,
# once per commit, in $MAKEMSIX_CACHE (default /cache/makemsix), and prints a
# command that runs it. For the desktop packaging image (Ubuntu, root).
set -eu
COMMIT=25a65f5c1690930813bcc10cdf1d59fa865f2bb1
dir="${MAKEMSIX_CACHE:-/cache/makemsix}/$COMMIT"
if [ ! -x "$dir/makemsix.sh" ]; then
  {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends clang make git zlib1g-dev libicu-dev python3-pip
    pip3 install -q cmake==3.31.6
    src=$(mktemp -d)
    git clone -q https://github.com/microsoft/msix-packaging "$src"
    git -C "$src" checkout -q "$COMMIT"
    (cd "$src" && ./makelinux.sh --pack)
    mkdir -p "$dir"
    cp "$src/.vs/bin/makemsix" "$src/.vs/lib/libmsix.so" "$dir/"
    printf '#!/bin/sh\nLD_LIBRARY_PATH="%s" exec "%s/makemsix" "$@"\n' "$dir" "$dir" > "$dir/makemsix.sh"
    chmod +x "$dir/makemsix.sh"
    rm -rf "$src"
  } >&2
fi
echo "$dir/makemsix.sh"
