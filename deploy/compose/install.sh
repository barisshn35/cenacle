#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Installs Cenacle on one Linux host with Docker Compose (prod.yml), the way
# docs/install/README.md describes by hand:
#
#   sudo sh install.sh [options]
#
# It looks at what the host has, not at the distribution's name: Docker Engine,
# Compose v2.24+, the processor type, memory, disk, ports 80 and 443, SELinux
# and the firewall. When something is missing it says what to do and stops; it
# never installs Docker and never changes firewall rules. With SELinux in
# enforcing mode it switches SELinux to permissive (now and in
# /etc/selinux/config, after a backup), says so and how to undo it, unless
# --keep-selinux is given. Then it writes the secrets and .env.prod (never over
# existing ones), starts the services and waits until they are healthy.
# Running it again changes nothing that is already in place.
#
# It runs from the compose directory (a git checkout's deploy/compose, or the
# release's cenacle-compose-<version>.tar.gz unpacked), or from a directory
# holding install.sh, cenacle-compose-<version>.tar.gz and the release's
# SHA256SUMS: then it checks the archive against SHA256SUMS and unpacks it
# into --dir (default /opt/cenacle). Verify SHA256SUMS's signature first
# (docs/install/README.md).
set -eu

TESTED='ubuntu:22.04 ubuntu:24.04 debian:12 debian:13 almalinux:9 almalinux:10 rocky:9 rocky:10'
MIN_COMPOSE=2.24.0
MIN_MEM_MB=2048
WARN_MEM_MB=4096
MIN_DISK_GB=10
WAIT_SECONDS=600

usage() {
  cat <<'EOF'
Usage: sudo sh install.sh [options]

  --domain NAME        the chat's host name (for example chat.example.com)
  --id-domain NAME     Cenacle ID's host name (for example id.example.com)
  --admin-email ADDR   the administrator's e-mail address in Cenacle ID
  --acme-email ADDR    Let's Encrypt's account e-mail (default: the administrator's)
  --tls-mode MODE      acme (default) | internal | files
  --dir DIR            where to unpack the release archive (default /opt/cenacle)
  --keep-selinux       leave SELinux as it is (see docs/install/README.md)
  --skip-port-check    do not stop when ports 80/443 are taken
  --calls              turn on voice and video calls (default: off; also CENACLE_CALLS=on)
  --calls-turn         calls with the built-in TURN relay (needs certs/media-turn.crt and .key)
  --media-public-ip IP the address users reach the media service on (asked when missing;
                       suggested from this host's interfaces, never looked up on the internet)
  --media-image REF    another cenacle-media image (default: the release's, like the others)
  --yes                ask nothing: the values above must be given as options
  --wait SECONDS       how long to wait for the services (default 600)
  -h, --help           this text
EOF
}

domain='' id_domain='' admin_email='' acme_email='' tls_mode=''
dir=/opt/cenacle keep_selinux='' skip_ports='' yes=''
calls_mode='' calls_turn='' calls_public_ip='' calls_image=''
[ "${CENACLE_CALLS:-off}" != on ] || calls_mode=1
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain=${2:?--domain needs a value}; shift 2 ;;
    --id-domain) id_domain=${2:?--id-domain needs a value}; shift 2 ;;
    --admin-email) admin_email=${2:?--admin-email needs a value}; shift 2 ;;
    --acme-email) acme_email=${2:?--acme-email needs a value}; shift 2 ;;
    --tls-mode) tls_mode=${2:?--tls-mode needs a value}; shift 2 ;;
    --dir) dir=${2:?--dir needs a value}; shift 2 ;;
    --keep-selinux) keep_selinux=1; shift ;;
    --skip-port-check) skip_ports=1; shift ;;
    --calls) calls_mode=1; shift ;;
    --calls-turn) calls_mode=1 calls_turn=1; shift ;;
    --media-public-ip) calls_public_ip=${2:?--media-public-ip needs a value}; shift 2 ;;
    --media-image) calls_image=${2:?--media-image needs a value}; shift 2 ;;
    --yes) yes=1; shift ;;
    --wait) WAIT_SECONDS=${2:?--wait needs a value}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# Until the compose directory is known, messages go to the screen only; then
# also to install.log there (the earlier ones are copied in).
log_file=''
early=''
say() {
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$*"
  if [ -n "$log_file" ]; then printf '%s\n' "$line" >> "$log_file"; else early="$early$line
"; fi
}
warn() { say "WARNING: $*"; }
fail() {
  say "STOPPED: $*"
  [ -n "$log_file" ] && printf 'The log of this run is in %s\n' "$log_file"
  exit 1
}

# 1. Where the compose files are.
here=$(cd "$(dirname "$0")" && pwd)
if [ -f "$here/prod.yml" ]; then
  compose_dir=$here
else
  archive=''
  for f in "$here"/cenacle-compose-*.tar.gz; do [ -f "$f" ] && archive=$f; done
  [ -n "$archive" ] || fail "no prod.yml next to install.sh and no cenacle-compose-<version>.tar.gz either: download both from the release (docs/install/README.md)"
  name=$(basename "$archive")
  [ -f "$here/SHA256SUMS" ] || fail "SHA256SUMS is missing next to $name: download it from the same release and verify its signature"
  sum=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$here/SHA256SUMS")
  [ -n "$sum" ] || fail "$name is not listed in SHA256SUMS"
  for tool in sha256sum tar gzip; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed to check and unpack $name: install it with the system's package manager"
  done
  [ "$(sha256sum "$archive" | cut -d' ' -f1)" = "$sum" ] || fail "$name does not match SHA256SUMS: download it again"
  say "$name matches SHA256SUMS"
  version=${name#cenacle-compose-}
  version=${version%.tar.gz}
  compose_dir=$dir/cenacle-compose-$version
  if [ -f "$compose_dir/prod.yml" ]; then
    say "keeping the files already unpacked in $compose_dir"
  else
    mkdir -p "$dir"
    tar -xzf "$archive" -C "$dir"
    [ -f "$compose_dir/prod.yml" ] || fail "$name did not unpack into $compose_dir"
    say "unpacked $name into $compose_dir"
  fi
fi
cd "$compose_dir"
log_file=$compose_dir/install.log
printf '%s' "$early" >> "$log_file"
say "installing from $compose_dir (log: $log_file)"

# 2. The host.
[ "$(id -u)" = 0 ] || fail "run it as root (sudo sh install.sh): it writes the secrets and may change SELinux"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  os_id=$(. /etc/os-release && printf '%s' "${ID:-unknown}")
  # shellcheck disable=SC1091
  os_version=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
  # shellcheck disable=SC1091
  os_name=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$os_id $os_version}")
else
  os_id=unknown os_version='' os_name='an unknown Linux'
fi
major=${os_version%%.*}
tested=''
for t in $TESTED; do
  case "$t" in "$os_id:$os_version" | "$os_id:$major") tested=1 ;; esac
done
if [ -n "$tested" ]; then
  say "host: $os_name"
else
  warn "this distribution was not tested: $os_name. Cenacle was tested (in containers) on Ubuntu 22.04 and 24.04, Debian 12 and 13, AlmaLinux 9 and 10, Rocky Linux 9 and 10. Continuing."
fi

missing=''
need() { missing="$missing
  - $*"; }

case "$(uname -m)" in
  x86_64 | amd64) say "processor: amd64" ;;
  aarch64 | arm64) say "processor: arm64" ;;
  *) need "a 64-bit x86 (amd64) or ARM (arm64) processor: this one is $(uname -m), for which there are no images" ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  need "Docker Engine: install it as Docker's guide says for this system, https://docs.docker.com/engine/install/ , then run install.sh again"
elif ! docker info >/dev/null 2>&1; then
  need "a running Docker Engine: 'docker info' fails. Start it (for example: systemctl enable --now docker) and run install.sh again"
else
  say "Docker Engine: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
  if ! compose=$(docker compose version --short 2>/dev/null); then
    need "Docker Compose v2 (the 'docker compose' plugin, $MIN_COMPOSE or later): https://docs.docker.com/compose/install/linux/"
  else
    compose=${compose#v}
    lowest=$(printf '%s\n%s\n' "$MIN_COMPOSE" "${compose%%[-+]*}" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)
    if [ "$lowest" = "$MIN_COMPOSE" ]; then
      say "Docker Compose: $compose"
    else
      need "Docker Compose $MIN_COMPOSE or later (this host has $compose): update the docker-compose-plugin package from Docker's repository"
    fi
  fi
fi

mem_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
mem_mb=$((mem_kb / 1024))
if [ "$mem_mb" -lt "$MIN_MEM_MB" ]; then
  need "at least $MIN_MEM_MB MB of memory (this host has $mem_mb MB)"
elif [ "$mem_mb" -lt "$WARN_MEM_MB" ]; then
  warn "$mem_mb MB of memory: enough to start, $WARN_MEM_MB MB or more is better for daily use"
else
  say "memory: $mem_mb MB"
fi

# Docker keeps images and volumes under its root directory.
data_dir=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
[ -n "$data_dir" ] && [ -d "$data_dir" ] || data_dir=/var/lib
for d in "$data_dir" "$compose_dir"; do
  free_gb=$(df -Pk "$d" | awk 'NR == 2 { print int($4 / 1048576) }')
  if [ "$free_gb" -lt "$MIN_DISK_GB" ]; then
    need "at least $MIN_DISK_GB GB free on the disk of $d (it has $free_gb GB)"
  else
    say "disk: $free_gb GB free for $d"
  fi
done

dc() {
  if [ -f .env.calls ] && grep -q '^CENACLE_CALLS_TURN=on' .env.calls; then
    docker compose -f prod.yml -f calls.yml -f calls-turn.yml --env-file .env.prod --env-file .env.calls "$@"
  elif [ -f .env.calls ]; then
    docker compose -f prod.yml -f calls.yml --env-file .env.prod --env-file .env.calls "$@"
  else
    docker compose -f prod.yml --env-file .env.prod "$@"
  fi
}
running_proxy=''
if [ -f .env.prod ] && docker info >/dev/null 2>&1; then
  running_proxy=$(dc ps -q --status running proxy 2>/dev/null || true)
fi
# Listening sockets from /proc (works without ss or netstat). $1 is tcp or udp,
# $2 the port in hex; TCP counts only in state LISTEN (0A).
listening() {
  for f in "/proc/net/$1" "/proc/net/${1}6"; do
    [ -r "$f" ] || continue
    awk -v p="$2" -v proto="$1" 'NR > 1 { split($2, a, ":"); if (a[2] == p && (proto == "udp" || $4 == "0A")) found = 1 } END { exit !found }' "$f" && return 0
  done
  return 1
}
if [ -n "$running_proxy" ]; then
  say "ports 80 and 443: used by this Cenacle's proxy already"
elif [ -z "$skip_ports" ]; then
  for p in tcp:80:0050 tcp:443:01BB udp:443:01BB; do
    proto=${p%%:*} rest=${p#*:}
    port=${rest%%:*} hex=${rest#*:}
    if listening "$proto" "$hex"; then
      need "port $port/$proto free: another program listens on it (see: ss -lntup | grep ':$port '). Stop it, or put Cenacle behind it (docs/install/README.md)"
    fi
  done
  say "ports 80/tcp, 443/tcp and 443/udp: checked"
fi

# Calls: check everything before anything is written, so a mistake leaves no half setup.
# A usable media address: not a host name, loopback, link-local, multicast or unspecified.
media_ip_ok() {
  case "$1" in
    *:*)
      case "$1" in *[!0-9a-fA-F:.]* | :: | ::1 | [fF][eE]8* | [fF][eE]9* | [fF][eE][aA]* | [fF][eE][bB]* | [fF][fF]*) return 1 ;; esac
      return 0 ;;
  esac
  printf '%s\n' "$1" | awk -F. 'NF != 4 { exit 1 }
    { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1 }
    $1 == 0 || $1 == 127 || ($1 == 169 && $2 == 254) || $1 >= 224 { exit 1 }'
}
# The host's own addresses, for the suggestion and the check (never asks the internet).
local_ips() {
  if command -v ip >/dev/null 2>&1; then
    ip -o addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }'
  elif hostname -I >/dev/null 2>&1; then
    hostname -I | tr ' ' '\n'
  else # the kernel's own table of local IPv4 addresses, without any tool
    awk '/\|--/ { a = $2 } /\/32 host LOCAL/ && a !~ /^127\./ { print a }' /proc/net/fib_trie 2>/dev/null | sort -u
  fi | grep -v '^$' || true
}
calls_new=''
if [ -n "$calls_mode" ] && [ -f .env.calls ]; then
  [ -z "$calls_public_ip$calls_image$calls_turn" ] ||
    warn "--media-public-ip, --media-image and --calls-turn are ignored because .env.calls exists; change them there"
elif [ -n "$calls_mode" ]; then
  calls_new=1
  [ -f calls.yml ] && [ -f gen-call-secrets.sh ] || fail "this release has no calls overlay or call key generator"
  command -v openssl >/dev/null 2>&1 || need "OpenSSL, to create the call keys (Ed25519)"
  if [ -z "$calls_public_ip" ] && [ -z "$yes" ] && (exec < /dev/tty) 2> /dev/null; then
    suggestion=$(local_ips | while read -r a; do if media_ip_ok "$a"; then echo "$a"; break; fi; done)
    printf '%s' "The address users reach this host on for calls (its public IP if behind NAT)${suggestion:+ [$suggestion]}: " > /dev/tty
    read -r calls_public_ip < /dev/tty || calls_public_ip=''
    calls_public_ip=${calls_public_ip:-$suggestion}
  fi
  if [ -z "$calls_public_ip" ]; then
    need "the media address for calls: give --media-public-ip (it is never looked up on the internet)"
  elif ! media_ip_ok "$calls_public_ip"; then
    need "a usable media address: '$calls_public_ip' is not an IP address users can reach (no host names, loopback, link-local or multicast addresses)"
  elif ! local_ips | grep -qxF "$calls_public_ip"; then
    warn "$calls_public_ip is not an address of this host: that is right only if a router forwards the call ports below to this host (NAT)"
  fi
  if [ -n "$calls_turn" ] && { [ ! -s certs/media-turn.crt ] || [ ! -s certs/media-turn.key ]; }; then
    need "for --calls-turn, the TURN certificate and key in $compose_dir/certs/media-turn.crt and media-turn.key"
  fi
  if [ -n "$calls_image" ] && ! printf '%s\n' "$calls_image" | grep -Eq '^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$'; then
    need "--media-image as an image reference (registry/name:tag or name@sha256:<digest>)"
  fi
fi
if [ -n "$calls_mode" ] && [ -z "$skip_ports" ] &&
  [ -z "$( [ -f .env.prod ] && docker info >/dev/null 2>&1 && dc ps -q --status running media 2>/dev/null || true)" ]; then
  call_checks='tcp:7881:1EC9 udp:7882:1ECA'
  if [ -n "$calls_turn" ] || { [ -f .env.calls ] && grep -q '^CENACLE_CALLS_TURN=on' .env.calls; }; then
    call_checks="$call_checks udp:3478:0D96 tcp:5349:14E5"
  fi
  for p in $call_checks; do
    proto=${p%%:*} rest=${p#*:}
    port=${rest%%:*} hex=${rest#*:}
    if listening "$proto" "$hex"; then
      need "port $port/$proto free for calls: another program listens on it (see: ss -lntup | grep ':$port ')"
    fi
  done
  say "call ports: checked"
fi

if [ -n "$missing" ]; then
  fail "this host needs:$missing"
fi

# 3. SELinux and the firewall.
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = Enforcing ]; then
  if [ -n "$keep_selinux" ]; then
    warn "SELinux is enforcing and --keep-selinux was given: it stays enforcing. Cenacle's containers were not tested that way; if a service cannot read its files, see docs/install/README.md"
  else
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    backup=''
    if [ -f /etc/selinux/config ]; then
      backup=/etc/selinux/config.before-cenacle-$stamp
      cp -p /etc/selinux/config "$backup"
      if grep -q '^SELINUX=' /etc/selinux/config; then
        sed -i 's/^SELINUX=.*/SELINUX=permissive/' /etc/selinux/config
      else
        printf 'SELINUX=permissive\n' >> /etc/selinux/config
      fi
    fi
    setenforce 0
    say "CHANGED: SELinux was enforcing; it is now permissive (setenforce 0)."
    if [ -n "$backup" ]; then
      say "CHANGED: /etc/selinux/config now says SELINUX=permissive, so it stays so after a restart. The old file is $backup."
      say "To undo: cp -p $backup /etc/selinux/config && setenforce 1"
    else
      say "/etc/selinux/config does not exist, so after a restart SELinux is as before. To undo now: setenforce 1"
    fi
    say "To keep SELinux enforcing instead, run install.sh with --keep-selinux (docs/install/README.md)."
  fi
elif command -v getenforce >/dev/null 2>&1; then
  say "SELinux: $(getenforce 2>/dev/null || echo unknown)"
fi

firewall=''
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then firewall=firewalld; fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then firewall="${firewall:+$firewall and }ufw"; fi
if [ -n "$firewall" ]; then
  say "firewall: $firewall is active. install.sh does not change it: allow 80/tcp, 443/tcp and 443/udp from your users yourself (docs/install/README.md)."
else
  say "firewall: no active firewalld or ufw found. If another firewall or the network filters traffic, allow 80/tcp, 443/tcp and 443/udp."
fi

# 4. Settings and secrets.
ask() { # variable question default
  if [ -n "$yes" ]; then return; fi
  printf '%s' "$2${3:+ [$3]}: " > /dev/tty
  # shellcheck disable=SC2034 # read by the eval below
  read -r answer < /dev/tty || answer=''
  eval "$1=\${answer:-\$3}"
}
if [ -f .env.prod ]; then
  say "keeping the existing .env.prod (it is never overwritten)"
  [ -z "$domain$id_domain$admin_email$acme_email$tls_mode" ] ||
    warn "the domain, e-mail and TLS options are ignored because .env.prod exists; change them there"
else
  # /dev/tty exists in a container or a cron job too, but cannot be opened there.
  if [ -z "$yes" ] && ! (exec < /dev/tty) 2> /dev/null; then
    fail "no terminal to ask on: give --domain, --id-domain and --admin-email with --yes"
  fi
  [ -n "$domain" ] || ask domain "The chat's host name (DNS must point here), for example chat.example.com" ''
  [ -n "$id_domain" ] || ask id_domain "Cenacle ID's host name, for example id.example.com" ''
  [ -n "$admin_email" ] || ask admin_email "The administrator's e-mail address" ''
  [ -n "$tls_mode" ] || ask tls_mode "TLS: acme (Let's Encrypt), internal (own test CA) or files (certs/)" acme
  tls_mode=${tls_mode:-acme}
  if [ "$tls_mode" = acme ] && [ -z "$acme_email" ]; then
    ask acme_email "Let's Encrypt's account e-mail" "$admin_email"
    acme_email=${acme_email:-$admin_email}
  fi
  [ -n "$domain" ] && [ -n "$id_domain" ] && [ -n "$admin_email" ] ||
    fail "the chat's and Cenacle ID's host names and the administrator's e-mail are needed (--domain, --id-domain, --admin-email)"
  [ "$domain" != "$id_domain" ] || fail "the chat and Cenacle ID need two different host names"
  case "$tls_mode" in acme | internal | files) ;; *) fail "--tls-mode must be acme, internal or files" ;; esac
  for v in "$domain" "$id_domain"; do
    case "$v" in *[!A-Za-z0-9.-]* | .* | *. | '') fail "not a host name: $v" ;; esac
  done
  for v in "$admin_email" "$acme_email"; do
    case "$v" in *[[:space:]\|\&\\]*) fail "not an e-mail address: $v" ;; esac
  done
  if [ "$tls_mode" = files ] && { [ ! -s certs/tls.crt ] || [ ! -s certs/tls.key ]; }; then
    fail "with --tls-mode files, put the certificate and key into $compose_dir/certs/tls.crt and tls.key first"
  fi
  umask 077
  sed -e "s|^CENACLE_DOMAIN=.*|CENACLE_DOMAIN=$domain|" \
    -e "s|^CENACLE_ID_DOMAIN=.*|CENACLE_ID_DOMAIN=$id_domain|" \
    -e "s|^CENACLE_TLS_MODE=.*|CENACLE_TLS_MODE=$tls_mode|" \
    -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$acme_email|" \
    -e "s|^CENACLE_ADMIN_EMAIL=.*|CENACLE_ADMIN_EMAIL=$admin_email|" \
    -e "s|^CENACLE_WEB_PUSH_SUBJECT=.*|CENACLE_WEB_PUSH_SUBJECT=mailto:$admin_email|" \
    -e "s|^CENACLE_SMTP_FROM=.*|CENACLE_SMTP_FROM=Cenacle <chat@$domain>|" \
    .env.prod.example > .env.prod.new
  mv .env.prod.new .env.prod
  umask 022
  say "wrote .env.prod: $domain, $id_domain, TLS $tls_mode, administrator $admin_email (file mode 0600)"
fi
count() { find secrets -mindepth 1 -maxdepth 1 2>/dev/null | wc -l; }
existing=$(count)
sh ./gen-secrets.sh > /dev/null
say "secrets in $compose_dir/secrets: $existing kept, $(($(count) - existing)) new. Back up secrets/ and .env.prod with the databases."

# Calls stay off unless asked for; a previous choice (.env.calls) is kept.
if [ -n "$calls_new" ]; then
  umask 077
  {
    printf 'CENACLE_MEDIA_PUBLIC_IP=%s\n' "$calls_public_ip"
    [ -z "$calls_image" ] || printf 'CENACLE_MEDIA_IMAGE=%s\n' "$calls_image"
    [ -z "$calls_turn" ] || printf 'CENACLE_CALLS_TURN=on\n'
  } > .env.calls.new
  mv .env.calls.new .env.calls
  umask 022
  say "wrote .env.calls: media address $calls_public_ip${calls_turn:+, TURN on}"
fi
if [ -f .env.calls ]; then
  sh ./gen-call-secrets.sh >> "$log_file" 2>&1 || fail "the call keys could not be created (see $log_file; no key is written there)"
  call_ports='7882/udp 7881/tcp'
  if grep -q '^CENACLE_CALLS_TURN=on' .env.calls; then call_ports="$call_ports 3478/udp 5349/tcp 49152-49407/udp"; fi
  say "calls are on for this installation. Workspace administrators still turn them on per workspace."
  say "install.sh does not change the firewall. Allow these ports from your users ($call_ports), for example:"
  case "$firewall" in *ufw*) show_ufw=1 ;; *) show_ufw='' ;; esac
  case "$firewall" in *firewalld*) show_fwd=1 ;; *) show_fwd='' ;; esac
  if [ -z "$firewall" ]; then show_ufw=1 show_fwd=1; fi
  if [ -n "$show_ufw" ]; then
    for p in $call_ports; do say "  ufw allow $(printf '%s' "$p" | tr '-' ':')"; done
  fi
  if [ -n "$show_fwd" ]; then
    for p in $call_ports; do say "  firewall-cmd --permanent --add-port=$p"; done
    say "  firewall-cmd --reload"
  fi
else
  say "calls are off (install.sh --calls turns them on; docs/install/calls.md)"
fi

# 5. Start and wait.
say "starting the services (images are pulled when missing)"
if ! dc up -d --no-build >> "$log_file" 2>&1; then
  fail "'docker compose up' failed; its output is in $log_file"
fi
deadline=$(($(date +%s) + WAIT_SECONDS))
while :; do
  states=$(dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null || true)
  # Running services must be healthy (or have no health check); one-shot jobs must exit 0.
  bad=$(printf '%s\n' "$states" | awk -F'|' 'NF >= 4 && !(($2 == "running" && ($3 == "healthy" || $3 == "")) || ($2 == "exited" && $4 == "0")) { print $1 }')
  [ -n "$states" ] && [ -z "$bad" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "these services are not ready after $WAIT_SECONDS seconds:"
    printf '%s\n' "$states" | awk -F'|' -v b=" $(printf '%s' "$bad" | tr '\n' ' ') " 'index(b, " " $1 " ") { printf "  %s: %s %s (exit code %s)\n", $1, $2, $3, $4 }' | tee -a "$log_file"
    for s in $bad; do
      say "--- the last 40 lines of $s's log:"
      dc logs --no-color --tail 40 "$s" 2>&1 | tee -a "$log_file"
    done
    fail "the services did not all become healthy"
  fi
  sleep 5
done
say "all services are healthy:"
dc ps --format '  {{.Service}}: {{.State}} {{.Health}}' 2>/dev/null | tee -a "$log_file"

# Through the proxy, as a browser would reach it (with the host names resolved here).
chat=$(sed -n 's/^CENACLE_DOMAIN=//p' .env.prod)
mode=$(sed -n 's/^CENACLE_TLS_MODE=//p' .env.prod)
if command -v curl >/dev/null 2>&1; then
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$chat:443:127.0.0.1" "https://$chat/readyz" || true)
  if [ "$code" = 200 ]; then
    say "https://$chat/readyz answers 200 through the proxy"
  elif [ "$mode" = acme ]; then
    warn "https://$chat/readyz does not answer yet ($code): with Let's Encrypt the certificate comes once DNS for $chat points here and port 80 is reachable from the internet (docker compose -f prod.yml --env-file .env.prod logs proxy)"
  else
    warn "https://$chat/readyz answers $code through the proxy (docker compose -f prod.yml --env-file .env.prod logs proxy)"
  fi
fi
say "done. Next: create the first administrator in Cenacle ID (docs/install/README.md, 'Administrator and default channels')."
