#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loads the images of an offline bundle (see bundle.sh) into the local Docker
# engine after checking the bundle's checksums.
set -eu
cd "$(dirname "$0")"
sha256sum -c SHA256SUMS
gunzip -c images.tar.gz | docker load
echo "loaded:"
cat images.txt
