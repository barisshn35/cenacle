# Calls: bounded source review and release gates

This is a source review of the new call paths, not a penetration-test certificate
or a complete codebase audit. Runtime exploitation tests, dependency/image scans,
browser/device evaluation and load qualification were not executed in the Windows
editing environment. No previous compatible security coverage ledger was supplied.

## Boundaries reviewed

| Boundary                 | Source controls                                                                                                                    | Unverified operator gate                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Browser → chat admission | channel/workspace membership, archive/encryption/default-off checks, one user/channel reservation constraints, call locks, quota   | integration/race tests after generation                                    |
| Browser → media          | exact Origin/path, first-frame single-use 60s EdDSA token, issuer/audience/node generation, bounded frames/ICE/SDP/rates           | replay, malformed messages, reconnect and fuzz                             |
| Media → chat             | unrelated signing key, internal listener, direct source CIDRs, freshness/replay, exact session/participant/generation checks       | network isolation, forged/replayed callbacks, logout/membership revocation |
| SFU resources            | bounded rooms/peers/tracks/queues/TCP connections/RTCP, keyframe-safe adaptation, authorization lease                              | prolonged adversarial signaling/RTP/RTCP and resource recovery             |
| Embedded TURN            | signed expiring credentials, transport ownership, allocation bounds, exact media destination, TLS, FIPS refusal                    | TURN/TLS, denied metadata/other-port targets, quota/restart churn          |
| Desktop capture          | actual paired main WebContents, top frame, native consent, gesture source menu, navigation recheck, no capture bridge/system audio | native OS/device and iframe/external/IdP-window tests                      |
| Metadata                 | own-only export, held redaction, hold-aware retention, cleanup while disabled, identity-free invalidations                         | integration tests for hold time overlap/release and erasure                |

Source review led to bounded live participant queries, identity-free invalidations,
sender bitrate budgeting across camera/screen, flood-close coalescing and rotating
reconciliation. These changes require runtime verification; they are not reported
as independently reproduced security findings. There is no blanket claim that the
remaining code is secure or that this review exhausts it.

## Checks run (2026-11-06)

All on the server tree with generated code (`make gen`), Go 1.26.10, Node 26:

- `make lint`, `make test-go` (race detector), `make test-js`, `make test-ci`,
  `make licenses`, `make build`; web e2e three times; desktop e2e under Xvfb in the
  CI image, including screen sharing through the source chooser (video only).
- `make test-e2e-stack` with `STACK_CALLS=1`: real chat server, Cenacle ID, media
  server and Chromium with fake devices: two people with camera and microphone, a
  reconnect as the same participant, a direct call declined and then accepted,
  three people with one screen at a time.
- Call integration tests against PostgreSQL and Valkey (admission races, token
  replay, encrypted channels, erasure and legal holds, the participant ceiling).
- Fuzzing of SDP, signalling and RTCP parsing, 60 s each, without a crash.
- Network egress: a capture of the media container's whole network namespace
  during a three-person call with a reconnect, checked by `TestCapturedMediaEgress`:
  only the call's peers, the chat server's control address and Valkey; no DNS, no
  STUN, no other destination. Narrowing the allow-list makes the check fail, as it
  should.
- `install.sh --calls` on the eight tested distributions (150 cases, `make
test-install-calls`), Helm lint and kube-linter for every `calls.exposure`.
- The media image: non-root (65532), `ci/check-image.sh` (no setuid, read-only),
  Trivy (no HIGH or CRITICAL), built for amd64 and arm64 (arm64 run under
  emulation); gitleaks on the tree (no leaks).
- Capacity on a 4 CPU / 8 GB media container, and a 30-minute soak with six
  reconnect rounds (docs/operations/performance.md).
- `make test-calls-k3d`: the chart's media service in k3s with each
  `calls.exposure` (host ports, LoadBalancer, host network), a call through each.

The tests found and fixed: an endless offer exchange when someone joined
listen-only; padding packets ending the publisher's transport; screen sharing
refused in the desktop app (Electron asks for "media" with no types); a stale
subscription after a publisher reconnected; one unanswered authorization request,
or a description over 32 media sections, ending the transport; the caller's dialog
staying open after a declined call; a first call in a new conversation not ringing.

## Limits

Not tested: real cameras and microphones on hardware, macOS (not supported),
TURN through a real NAT, and a soak longer than 30 minutes. Live
captions are not supported (WCAG 1.2.4). The media server can read call media, so
calls stay off in end-to-end encrypted channels.
