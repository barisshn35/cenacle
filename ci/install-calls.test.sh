#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# install.sh with calls (--calls, --calls-turn, CENACLE_CALLS=on) on each tested
# distribution, in containers. A stand-in for docker answers install.sh's
# questions and records the compose commands: no Cenacle image is pulled or
# started. Needs Docker and pulls the distribution images when missing.
#
#   sh ci/install-calls.test.sh [image...]
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
images=${*:-"ubuntu:22.04 ubuntu:24.04 debian:12 debian:13 almalinux:9 almalinux:10 rockylinux/rockylinux:9 rockylinux/rockylinux:10"}
helper=alpine:3.22
work=$(mktemp -d)
made=''
cleanup() {
  for tag in $made; do docker image rm -f "$tag" >/dev/null 2>&1 || true; done
  docker rm -f cenacle-install-port >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

# The stand-in for docker: Engine 29, Compose 2.40, every service healthy.
cat > "$work/docker" <<'EOF'
#!/bin/sh
echo "$*" >> /tmp/docker.log
case "$1" in
  info) case "$*" in *DockerRootDir*) echo /var/lib ;; esac ;;
  # Another stack of the same project name, from another directory (CLASH_DIR).
  ps) if [ -n "${CLASH_DIR:-}" ]; then echo "$CLASH_DIR"; fi ;;
  version) echo 29.0.0 ;;
  compose)
    case "$*" in
      *"version --short"*) echo 2.40.0 ;;
      *" up "*) case "$*" in *calls.yml*) : > /tmp/with-media ;; esac ;;
      *" ps -a --format"*)
        printf 'proxy|running|healthy|0\nserver|running|healthy|0\nmigrate|exited||0\n'
        if [ -f /tmp/with-media ]; then printf 'media|running|healthy|0\n'; fi ;;
      *" ps --format"*) printf '  proxy: running healthy\n' ;;
    esac ;;
esac
exit 0
EOF

chmod +x "$work/docker"

# What one case runs in a fresh container: a copy of deploy/compose, then install.sh.
cat > "$work/case.sh" <<'EOF'
#!/bin/sh
set -u
rm -rf /opt/c && cp -R /src /opt/c && cd /opt/c
rm -rf secrets .env.prod .env.calls install.log certs/media-turn.*
if [ -n "${TURN_CERTS:-}" ]; then
  openssl req -x509 -newkey ed25519 -nodes -subj /CN=chat.example.test -days 1 \
    -keyout certs/media-turn.key -out certs/media-turn.crt >/dev/null 2>&1
fi
# "own" stands for this container's address, read here (containers' addresses vary).
own=$(awk '/\|--/ { a = $2 } /\/32 host LOCAL/ && a !~ /^127\./ { print a }' /proc/net/fib_trie | sort -u | head -n 1)
for arg; do
  shift
  if [ "$arg" = own ]; then set -- "$@" "$own"; else set -- "$@" "$arg"; fi
done
sh install.sh --yes --domain chat.example.test --id-domain id.example.test \
  --admin-email admin@example.test --tls-mode internal --wait 5 "$@"
echo "EXIT=$?"
for f in .env.prod .env.calls; do [ -f "$f" ] && echo "FILE $f" && cat "$f"; done
ls -l secrets 2>/dev/null | awk '/_private.pem|media_turn_secret/ { print "SECRET", $1, $NF }'
[ -f /tmp/docker.log ] && grep ' up ' /tmp/docker.log | sed 's/^/UP /'
if [ -n "${AGAIN:-}" ]; then
  echo "--- again"
  sh install.sh --yes --wait 5 --calls --media-public-ip 198.51.100.4
  echo "EXIT=$?"
  cat .env.calls
fi
EOF

failed=0
check() { # name output pattern...
  name=$1 out=$2
  shift 2
  for pattern in "$@"; do
    case "$pattern" in
      '!'*) if grep -qE -- "${pattern#!}" "$out"; then echo "FAIL $name: found '${pattern#!}'"; failed=1; return; fi ;;
      *) if ! grep -qE -- "$pattern" "$out"; then echo "FAIL $name: missing '$pattern'"; tail -n 15 "$out" | sed 's/^/  | /'; failed=1; return; fi ;;
    esac
  done
  echo "ok   $name"
}

docker pull -q "$helper" >/dev/null
for image in $images; do
  tag="cenacle-install-test:$(echo "$image" | tr '/:' '--')"
  echo "=== $image"
  docker pull -q "$image" >/dev/null
  # Without OpenSSL calls cannot get their keys: install.sh says so before writing anything.
  out=$work/out
  if ! docker run --rm "$image" sh -c 'command -v openssl' >/dev/null 2>&1; then
    docker run --rm -v "$root/deploy/compose:/src:ro" -v "$work/docker:/usr/local/bin/docker:ro" \
      -v "$work/case.sh:/case.sh:ro" "$image" sh /case.sh --calls --media-public-ip 198.51.100.4 > "$out" 2>&1 || true
    check "no OpenSSL" "$out" 'OpenSSL, to create the call keys' 'EXIT=1' '!FILE \.env\.prod'
  fi
  # One image per distribution with OpenSSL; removed at the end.
  case "$image" in
    *ubuntu* | *debian*) install='apt-get update -qq && apt-get install -y -qq --no-install-recommends openssl >/dev/null' ;;
    *) install='(dnf install -y -q openssl || microdnf install -y openssl) >/dev/null' ;;
  esac
  printf 'FROM %s\nRUN %s\n' "$image" "$install" | docker build -q -t "$tag" - >/dev/null
  made="$made $tag"
  run() {
    docker run --rm -v "$root/deploy/compose:/src:ro" -v "$work/docker:/usr/local/bin/docker:ro" \
      -v "$work/case.sh:/case.sh:ro" "$@" > "$out" 2>&1 || true
  }

  run "$tag" sh /case.sh
  check "calls off by default" "$out" 'EXIT=0' 'calls are off' '!FILE \.env\.calls' '!UP .*calls\.yml'

  run "$tag" sh /case.sh --calls
  check "no media address" "$out" 'EXIT=1' '!Docker Engine:.*install it' 'the media address for calls' '!FILE \.env\.prod' '!FILE \.env\.calls'

  for bad in 127.0.0.1 169.254.1.1 0.0.0.0 224.0.0.1 999.1.1.1 chat.example.test ::1 fe80::1; do
    run "$tag" sh /case.sh --calls --media-public-ip "$bad"
    check "bad address $bad" "$out" 'EXIT=1' 'not an IP address users can reach' '!FILE \.env\.prod'
  done

  run "$tag" sh /case.sh --calls --media-public-ip own
  check "the host's own address" "$out" 'EXIT=0' 'CENACLE_MEDIA_PUBLIC_IP=[0-9]' '!not an address of this host' \
    'UP .*-f calls\.yml' '!UP .*calls-turn' 'SECRET -rw-r--r-- calls_private.pem' \
    'ufw allow 7882/udp' 'ufw allow 7881/tcp' 'firewall-cmd --permanent --add-port=7882/udp' \
    'firewall-cmd --reload' '!3478'

  AGAIN=1 run -e AGAIN=1 "$tag" sh /case.sh --calls --media-public-ip 203.0.113.9
  check "address behind NAT, kept on a second run" "$out" 'EXIT=0' \
    'WARNING: 203\.0\.113\.9 is not an address of this host' 'keeping \.env\.calls|are ignored because \.env\.calls exists' \
    '!CENACLE_MEDIA_PUBLIC_IP=198\.51\.100\.4'

  run -e CLASH_DIR=/root/other/deploy/compose "$tag" sh /case.sh
  check "another stack named cenacle" "$out" 'EXIT=1' "another Compose project named 'cenacle' runs from /root/other/deploy/compose" \
    'COMPOSE_PROJECT_NAME=<name>' '!FILE \.env\.prod' '!UP '

  run -e CENACLE_CALLS=on "$tag" sh /case.sh --media-public-ip 203.0.113.9
  check "CENACLE_CALLS=on" "$out" 'EXIT=0' 'FILE \.env\.calls' 'UP .*-f calls\.yml'

  run "$tag" sh /case.sh --calls-turn --media-public-ip 203.0.113.9
  check "TURN without its certificate" "$out" 'EXIT=1' 'media-turn\.crt' '!FILE \.env\.prod'

  run -e TURN_CERTS=1 "$tag" sh /case.sh --calls-turn --media-public-ip 203.0.113.9
  check "TURN" "$out" 'EXIT=0' 'CENACLE_CALLS_TURN=on' 'UP .*-f calls-turn\.yml' \
    'ufw allow 3478/udp' 'ufw allow 49152:49407/udp' 'firewall-cmd --permanent --add-port=49152-49407/udp'

  run "$tag" sh /case.sh --calls --media-public-ip 203.0.113.9 --media-image 'not an image!'
  check "bad media image" "$out" 'EXIT=1' '--media-image as an image reference'

  # Ports taken by another program (a listener in the same network namespace).
  for port in 7882/udp 7881/tcp; do
    docker rm -f cenacle-install-port >/dev/null 2>&1 || true
    case "$port" in
      */udp) listen="nc -lu -p ${port%/*}" ;;
      *) listen="nc -lk -p ${port%/*}" ;;
    esac
    docker run -d --name cenacle-install-port "$helper" sh -c "$listen" >/dev/null
    sleep 1
    run --network container:cenacle-install-port "$tag" sh /case.sh --calls --media-public-ip 203.0.113.9
    check "port $port taken" "$out" 'EXIT=1' "port $port free for calls" '!FILE \.env\.prod'
  done
  docker rm -f cenacle-install-port >/dev/null 2>&1 || true
done
if [ "$failed" != 0 ]; then
  echo "install.sh call cases failed" >&2
  exit 1
fi
echo "all install.sh call cases passed"
