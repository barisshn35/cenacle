#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Fails unless this job's container runs the CI image that the pipeline's own
# ci-image job built (CI_IMAGE_ID, its dotenv report): release jobs handle the
# signing keys and must not run in an image another pipeline tagged with the
# same name in the shared CI engine (docs/operations/ci.md).
set -eu
if [ -z "${CI_IMAGE_ID:-}" ]; then
  echo "CI_IMAGE_ID is not set: this job needs the ci-image job's report"
  exit 1
fi
# The runner labels each job's build container with the job's id.
self="$(docker ps -q --no-trunc \
  --filter "label=com.gitlab.gitlab-runner.job.id=$CI_JOB_ID" \
  --filter label=com.gitlab.gitlab-runner.type=build)"
if [ -z "$self" ] || [ "$(printf '%s\n' "$self" | wc -l)" -ne 1 ]; then
  echo "cannot tell which container runs this job"
  exit 1
fi
image="$(docker inspect -f '{{.Image}}' "$self")"
if [ "$image" != "$CI_IMAGE_ID" ]; then
  echo "this job runs in $image, not in the CI image this pipeline built ($CI_IMAGE_ID)"
  exit 1
fi
echo "CI image: $image"
