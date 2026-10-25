#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Passive OWASP ZAP baseline scan of a Cenacle installation:
#   ci/zap.sh https://chat.test.example [report-dir]
# Run it against a test installation. The report is written to report-dir
# (default: the current directory) as zap-report.html. ZAP_NETWORK names a
# Docker network to scan from (default: the host's).
set -eu
target=${1:?usage: ci/zap.sh <url> [report-dir]}
out=${2:-$PWD}
docker run --rm --network "${ZAP_NETWORK:-host}" -v "$out:/zap/wrk:rw" \
	ghcr.io/zaproxy/zaproxy:2.17.0 zap-baseline.py -t "$target" -r zap-report.html -I
