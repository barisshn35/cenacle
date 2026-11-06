# Self-hosted calls

Calls use a separate `cenacle-media` process in the server Go module. The chat
server owns authorization, durable state and single-use admission. The media
process forwards Opus/VP8 and never receives database, IdP or admission-private
credentials. All browser signaling stays at the chat origin under `/media/ws`.
No public STUN or IP-discovery service is configured.

Calls are off by default at installation and workspace levels. A call holds 8
people by default; a workspace administrator can allow up to 16. One media host
with 4 CPUs and 8 GB carries one 16-person call or two 8-person calls
([measurements](../operations/performance.md)); give it more CPUs for more large
calls at once.
Encrypted/MLS channels cannot call: the SFU can read media. Recording,
transcription, live captions and system-audio sharing are not implemented.

## Upgrade and image

Migration 00064 (call tables and workspace settings) runs with the release, like
every migration. Rolling back requires disabling calls and draining active calls
before rolling back code; the down migration destroys call metadata and settings,
so do not run it as an automatic rollback.

The media image is `cenacle-media`, released with the others under the same
version (`ghcr.io/cenacle-tr/cenacle-media:<version>`, amd64 and arm64) and built
from `server/media.Dockerfile`. Compose and Helm use it by default; to pin a
digest or use your own registry, set `CENACLE_MEDIA_IMAGE` (Compose) or
`calls.image` (Helm). The image runs as UID/GID 65532, read-only, without
capabilities or a shell; its base images are digest-pinned in the Dockerfile.

## Compose

On the Linux host, with Docker, Compose and OpenSSL installed:

```sh
cd deploy/compose
sudo sh install.sh --calls            # or CENACLE_CALLS=on sh install.sh
sudo sh install.sh --calls-turn       # calls with the built-in TURN relay
```

The usual domain, TLS and administrator options still apply. Without
`--media-public-ip`, install.sh asks for the address users reach this host on
for calls and suggests one of the host's own addresses; it never asks a service
on the internet. With `--yes` the option is required. It refuses host names,
loopback, link-local, multicast and unspecified addresses, warns when the
address is not one of this host's (right only behind NAT that forwards the call
ports) and stops when 7882/udp or 7881/tcp (and with TURN 3478/udp, 5349/tcp) is
taken. All of this is checked before anything is written, so a refusal leaves
no half-finished installation.

`make test-install-calls` checks all of this on the eight tested distributions, in
containers.

install.sh does not change the firewall: it prints the commands for what it finds (ufw,
firewalld, or both when neither is active), for example:

```sh
ufw allow 7882/udp
ufw allow 7881/tcp
firewall-cmd --permanent --add-port=7882/udp
firewall-cmd --permanent --add-port=7881/tcp
firewall-cmd --reload
```

It creates `.env.calls` only after explicit opt-in (the media address, and
`CENACLE_CALLS_TURN=on` or `CENACLE_MEDIA_IMAGE` when given), preserves it on
later runs and generates two unrelated Ed25519 key pairs (and the TURN secret).
It never rotates or prints keys. The secrets directory is 0700; Compose
bind-mounted files are 0644 so the non-root containers can read them. Protect
and back up that directory. `--skip-port-check` does not open any ports.

For normal administration after opt-in:

```sh
docker compose -f prod.yml -f calls.yml --env-file .env.prod --env-file .env.calls up -d
```

The media image receives only the admission public key and control private key;
chat receives the reverse halves. Callback traffic uses `calls-control-server`
on a dedicated internal `172.29.88.0/28` network. Only media `.2/32` is admitted
at chat port 7883, in addition to signature/replay/session checks. If that subnet
conflicts with your host, change the overlay subnet, media address and callback
CIDR together. Port 7883 is never published or routed by the proxy.

| Port            | Exposure                   | Purpose                         |
| --------------- | -------------------------- | ------------------------------- |
| 443/TCP         | Existing chat TLS origin   | API and signaling WebSocket     |
| 7882/UDP        | Forward to this media node | Shared ICE UDP mux              |
| 7881/TCP        | Forward to this media node | ICE-TCP fallback                |
| 7880/TCP        | Internal only              | Signaling, health and readiness |
| 7883/TCP        | Internal only              | Signed media-to-chat control    |
| 3478/UDP        | Optional TURN only         | TURN control                    |
| 5349/TCP        | Optional TURN only         | TURN over TLS                   |
| 49152–49407/UDP | Optional TURN only         | Bounded relay allocations       |

One media replica/node is supported. Never scale it or overlap generations to
"move" calls. A lost node lease ends its transports; users rejoin new calls.
Ordinary transport interruptions allow 30 seconds with the same participant.
Installation opt-in does not enable any workspace: a workspace administrator
opens Call settings in a channel header, enables calls and separately chooses
whether guests may initiate. Guests can join channels they can access.

## Optional embedded TURN

TURN stays off unless `install.sh --calls-turn` (or `calls-turn.yml` after
`calls.yml`) turns it on. Put a certificate for the chat host in
`certs/media-turn.crt` and its private key in `certs/media-turn.key` first. The
call-key generator creates a separate random TURN secret. By hand, add the third
overlay to every up/restart invocation. Do not publish TURN ports when the feature
is off.

Only this installation's TURN endpoints are returned. Credentials last ten
minutes; ICE restart refreshes them. Existing allocations can refresh while the
authorized transport remains alive; expired credentials cannot allocate anew.
The relay permits only this SFU's public IP and UDP mux port, with four allocations
per transport and 256 globally. Changing the relay range must also change published
ports and firewall rules. TURN refuses Go FIPS mode because its upstream long-term
authentication uses MD5; it never disables FIPS to proceed.

## Kubernetes / Helm

The chart's `calls.enabled` defaults to false. Set `calls.publicIP` and narrow
`calls.callbackCIDRs` matching the media pod's actual source addresses (with
`hostNetwork`, the node's). `calls.image` defaults to the release's media image.
There is one replica with Recreate updates; no HPA or multi-node migration.

`calls.exposure` chooses how users reach the media ports (7882/udp, 7881/tcp,
and TURN's when on):

| `calls.exposure`     | How                                                      | Needs                                                    |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `hostPort` (default) | The node's ports, through the CNI's port mapping         | `calls.nodeSelector` for the node `publicIP` reaches     |
| `loadBalancer`       | A `LoadBalancer` Service with the same UDP and TCP ports | A load balancer whose address is `calls.publicIP`        |
| `hostNetwork`        | The pod on the node's network, without NAT               | `calls.nodeSelector`; filter on the node, not in the CNI |

With `loadBalancer`, `calls.loadBalancer.loadBalancerIP` and `.annotations` are
passed to the Service (`externalTrafficPolicy: Local`); the address candidates
name is `calls.publicIP`, so the two must match. With `hostNetwork`, NetworkPolicy
does not apply to the pod with most CNIs: allow only the call ports on the node's
own firewall. The signalling Service is internal, and the TLS Ingress adds
`/media/`. No control Ingress is created.

Create `calls.existingSecret` with keys `calls-private`, `calls-public`,
`control-private`, `control-public`; for TURN add `turn-secret`, `turn-cert`,
`turn-key`. Each container mounts only its necessary keys. The existing base
Secret supplies the media process only its Valkey password, not database or IdP
keys. Enable the chart's NetworkPolicies and verify that the CNI enforces them.
The callback port admits only media pod labels plus signed requests. Helm refuses
an unrestricted callback CIDR and missing topology settings.

`make test-calls-k3d` (`ci/calls-helm-smoke.sh`) deploys the chart's media service
into a disposable k3d cluster once per `calls.exposure` and places a three-person
call with a reconnect through each.

## Offline installation

On the connected build host run `deploy/airgap/bundle.sh --calls OUTPUT` with
`.env.calls` present and the pinned media image available. `--calls-turn` includes
both overlays. The existing bundle checksum/containerd-digest verification still
applies. It copies empty secret placeholders only, never live keys. Move the
matching Compose release files, verified image bundle and separately protected
secrets/certificates to the offline host. Load using `load.sh`, then use all the
same overlays and `--pull never`. Do not enable external ACME, push, previews or
other optional external integrations in an isolated installation.

## Network and operational verification

Check internal `/healthz` and `/readyz`, then place test calls over UDP and with
UDP blocked to verify ICE-TCP; enable TURN and test TURN/TLS separately. Readiness
checks the cache, the node lease and signed chat-control access. Measured capacity
is in [performance](../operations/performance.md).

Capture the entire media network namespace (`tcpdump -i any -s 0 -w capture.pcap`)
through real fixture calls, disconnect/rejoin and TURN attempts. Use classic PCAP
with raw-IP, Ethernet or Linux cooked v1; unsupported/truncated/fragmented input
fails the checker instead of silently passing. Set `CENACLE_MEDIA_PCAP`,
`CENACLE_MEDIA_CAPTURE_SOURCES` (every outgoing source address, including local
resolver traffic), `CENACLE_MEDIA_CAPTURE_ALLOW_CIDRS` (exact infrastructure and
fixture-peer IPs; no /0) and `CENACLE_MEDIA_CAPTURE_DNS_NAMES` (exact permitted
internal service names). Run:

```sh
cd server
go test ./internal/media -run '^TestCapturedMediaEgress$' -count=1
```

Missing capture explicitly skips; a skip is not an egress pass. Include IPv6 in
capture scope. Unsupported IPv6 extensions require explicit analysis. An actual
remote call participant is an expected media endpoint, not an external service.
Protect captures as sensitive troubleshooting data and delete them after review;
never publish raw captures, admission tokens, SDP, ICE candidates or relay secrets.

If joins fail, check workspace/installation switches, channel membership/archive
and encryption, media readiness, operator IP/NAT forwarding, proxy WS upgrades,
control CIDRs and clock synchronization. Device failures need browser/OS permission
and an available input. Mobile capture and desktop native source selection require
real-device verification. Call metadata follows channel/workspace retention and
legal holds; media bytes are never stored.

## Configuration reference

All string settings support `_FILE`; setting both forms is rejected. Keys are PEM
PKCS8 private / PKIX public Ed25519, with independent pairs for each direction.

| Setting                                                      | Default / purpose                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `CENACLE_CALLS`                                              | off; installation switch in chat                               |
| `CENACLE_CALLS_PRIVATE_KEY`                                  | chat-only admission signer; required when on                   |
| `CENACLE_CALLS_PUBLIC_KEY`                                   | media-only admission verifier                                  |
| `CENACLE_CALLS_KEY_ID`                                       | `calls-1`, same identifier in both processes                   |
| `CENACLE_MEDIA_CONTROL_PRIVATE_KEY`                          | media-only callback signer                                     |
| `CENACLE_MEDIA_CONTROL_PUBLIC_KEY`                           | chat-only callback verifier                                    |
| `CENACLE_CALLS_INTERNAL_ADDR`                                | `127.0.0.1:7883`; explicitly bind container internal listener  |
| `CENACLE_MEDIA_INTERNAL_CIDRS`                               | loopback; explicit narrow media source allowlist in containers |
| `CENACLE_MEDIA_CONTROL_URL`                                  | `http://127.0.0.1:7883/control`; internal only                 |
| `CENACLE_MEDIA_HTTP_ADDR`                                    | `:7880`; never publish directly                                |
| `CENACLE_MEDIA_NODE_ID`                                      | `media-1`; single node lease identity                          |
| `CENACLE_MEDIA_PUBLIC_IP`                                    | required; literal unicast IP supplied by operator              |
| `CENACLE_PUBLIC_URL`                                         | exact chat origin; HTTPS except loopback development           |
| `CENACLE_VALKEY_ADDR` / `CENACLE_VALKEY_PASSWORD`            | existing private cache endpoint/credential                     |
| `CENACLE_MEDIA_TURN`                                         | off; separately enables embedded relay                         |
| `CENACLE_MEDIA_TURN_SECRET`                                  | separate random secret, at least 32 characters                 |
| `CENACLE_MEDIA_TURN_TLS_CERT` / `CENACLE_MEDIA_TURN_TLS_KEY` | required only for media TURN                                   |
| `CENACLE_MEDIA_TURN_URLS`                                    | own host UDP3478/TLS5349 only; no STUN fallback                |
| `CENACLE_MEDIA_TURN_RELAY_MIN` / `MAX`                       | 49152 / 49407; published range must match                      |
| `CENACLE_MEDIA_TURN_MAX_ALLOCATIONS`                         | 256; range must cover configured maximum                       |

In a call, Ctrl/Cmd+Shift+M turns the microphone on or off, Ctrl/Cmd+Shift+O the
camera, Ctrl/Cmd+Shift+E screen sharing, and Ctrl/Cmd+Shift+H leaves; the keyboard
shortcuts dialog lists them. Device access begins only after a user action;
joining is listen-only.
