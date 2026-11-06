# ADR 0050: Calls: own media server

Status: accepted (2026-11-05). Replaces the LiveKit plan of the 0.99.5 call plan.

## Context

Cenacle needs voice and video calls hosted by the institution itself, without
external STUN, hosted signalling or media-service SDKs, and with the existing
server-to-client WebSocket contract unchanged. A media server that forwards media
can read it, so calls cannot keep the promise of end-to-end encrypted (MLS)
channels.

## Decision

A separate Go process and image, `cenacle-media`, in the server module, with Pion
WebRTC and optional Pion TURN (all MIT). The chat server owns the call and
participant records in PostgreSQL, authorization, outbox events and workspace
policy. Signalling is a separate same-origin `/media/ws` connection. The chat
server signs single-use EdDSA admissions valid for 60 seconds; the media server
holds only that public key and an unrelated private key for its callbacks. The
callbacks reach an internal listener with source-address checks, signatures,
replay prevention and a fresh check of session and channel access. Valkey node
and room leases fence process generations. A refusal closes the transport at
once. When the chat server cannot be reached, forwarding stops as soon as the last
authorization (5 s) lapses and the transport closes 10 s later, so one lost request
or a chat restart does not end calls; nothing fails open.

Opus (DTX, FEC) and VP8 only; the camera as three simulcast layers (q/h/f), the
screen as one video-only layer, one shared screen per room. One UDP mux port and
one ICE-TCP port, on the address the operator gives. Queues, tracks, signalling,
ICE, RTCP, rooms and connections are bounded. Each receiver's bandwidth estimate
and tile size choose its layer, switched at key frames.

Negotiation: the browser offers and stays polite on collisions. The SFU offers
only when it adds or removes a subscriber's track (and for ICE restarts), not on
Pion's negotiation-needed signal: for the track-less transceivers a listen-only
browser's offer creates, Pion reports negotiation as needed after every exchange,
and the two sides would offer each other without end. Each publication travels
as its own stream, and the browser names received tracks by stream ID: a reused
receiver keeps a local track ID. Padding-only packets (bandwidth probes) carry no
VP8 payload and are skipped, never treated as an attack.

One media replica with Recreate updates; no room migration or multi-node routing.
Calls are off by default, at installation and workspace level, and unavailable in
encrypted (MLS) channels. Helm exposes the media ports through host ports, a
LoadBalancer Service or the host network. The room limit is a constant of the media
build: 16, as measured on a 4 CPU / 8 GB host (workspaces default to 8). A
separate build tag (`medialab`) raises it to 25 for capacity measurements only,
never in a release image; the subscription, SDP section and size limits follow
from it. TURN is opt-in, with short-lived credentials, bounded
allocations, relaying only to this SFU's UDP port, and refused in Go FIPS mode
(its upstream long-term authentication uses MD5).

## Consequences

The media server can read call media; none is stored. Call records join erasure,
export, retention and legal holds; public snapshots hide held, erased identities.
Call events carry invalidations, not replayable participant lists. On the desktop,
capture stays in the main process with native per-request consent and a source
chooser after a click, without an IPC bridge for capture.

No recording, live captions, transcription, SIP, streaming, H.264/AV1, public STUN
fallback or proprietary noise and background processing. WCAG 1.2.4 is reported
as not supported. Capacity is measured with `server/cmd/media-load` against the
media image at 4 CPUs and 8 GB (docs/operations/performance.md).
