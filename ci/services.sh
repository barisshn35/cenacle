#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Starts the services a CI job needs on 127.0.0.1 and waits until they are
# healthy. CI jobs share the network of the CI Docker engine, so a published
# port is reachable at 127.0.0.1 as on a developer's machine.
#
#   ci/services.sh postgres-chat[:port] postgres-idp[:port] valkey garage ldap
#   ci/services.sh stop          # removes CI services (left over by a job that died, too)
set -eu
cd "$(dirname "$0")/.."

job="${CI_JOB_ID:-local}"
label="cenacle-ci-job=$job"
PG_IMAGE=postgres:18.6-alpine3.24
VALKEY_IMAGE=valkey/valkey:9.0.6-alpine
PASSWORD=ci-only-password

wait_healthy() {
  for _ in $(seq 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = healthy ] && return 0
    sleep 2
  done
  docker logs "$1"
  exit 1
}

# A job that died may have left its services behind: they hold the ports.
stop_all() {
  docker ps -aq --filter "label=cenacle-ci-job" | xargs -r docker rm -f >/dev/null
  docker rm -f cenacle-ci-garage >/dev/null 2>&1 || true
}

postgres() { # name port user database
  docker run -d --name "ci-$job-$1" --label "$label" -p "127.0.0.1:$2:5432" \
    -e POSTGRES_USER="$3" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$4" \
    --health-cmd "pg_isready -U $3 -d $4" --health-interval 2s --health-timeout 3s --health-retries 45 \
    "$PG_IMAGE" >/dev/null
  wait_healthy "ci-$job-$1"
}

if [ "${1:-}" = stop ]; then
  stop_all
  exit 0
fi

for service in "$@"; do
  name="${service%%:*}"
  port="${service#*:}"
  [ "$port" = "$service" ] && port=
  case "$name" in
    postgres-chat) postgres pg-chat "${port:-5432}" cenacle_chat cenacle_chat_test ;;
    postgres-idp) postgres pg-idp "${port:-5432}" cenacle_idp cenacle_idp_test ;;
    valkey)
      docker run -d --name "ci-$job-valkey" --label "$label" -p "127.0.0.1:${port:-6379}:6379" \
        --health-cmd "valkey-cli ping" --health-interval 2s --health-timeout 3s --health-retries 45 \
        "$VALKEY_IMAGE" >/dev/null
      wait_healthy "ci-$job-valkey"
      ;;
    garage) deploy/compose/garage/run-ci.sh ;;
    ldap)
      docker build -q -t cenacle-ci-ldap deploy/compose/ldap >/dev/null
      docker run -d --name "ci-$job-ldap" --label "$label" -p "127.0.0.1:${port:-13389}:3389" \
        -e LDAP_ADMIN_PASSWORD="${IDP_TEST_LDAP_PASSWORD:-$PASSWORD}" cenacle-ci-ldap >/dev/null
      wait_healthy "ci-$job-ldap"
      ;;
    *)
      echo "unknown service: $service" >&2
      exit 2
      ;;
  esac
  echo "$name ready"
done
