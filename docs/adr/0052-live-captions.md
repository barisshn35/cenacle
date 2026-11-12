# ADR 0052: Calls: live captions

Status: accepted (2026-11-12).

## Context

Live captions help people who are deaf or hard of hearing (WCAG 2.2, 1.2.4
Captions (Live), level AA), people in noisy places and people following a call
in a second language. Cenacle is self-hosted and may run without internet
access; no audio may leave the institution, and the browsers' own speech
recognition sends audio to their vendor. The media server forwards Opus without
decoding it; decoding on the server would add a C library (libopus) to a Go
binary built without cgo.

## Decision

- **Speech to text runs in the institution**, in an optional service:
  whisper.cpp's HTTP server (MIT) with a Whisper model (MIT), as a Compose
  overlay (`captions.yml`, image pinned by digest). The model is downloaded once
  at install time (`install.sh --captions`); without internet the administrator
  copies the file into the volume. The chat server reaches it at
  `CENACLE_CAPTIONS_URL` on an internal network; nothing else does.
- **Each speaker's app sends its own microphone**, not the media server: while
  captions are on in a call, the app takes its microphone (after noise
  suppression), resamples it to 16 kHz mono and sends what lies between pauses
  (0.6 to 12 seconds, speech only) to `POST /api/calls/{id}/captions/audio`. The
  chat server checks that the sender is connected to that call, limits the rate
  and the size, passes the audio to the service with the workspace's language
  (or automatic) and sends the text to the call as `call.caption` (ephemeral:
  speaker, text, time). No audio or text is stored here.
- **Turning captions on is visible**: anyone in a call can turn them on or off
  (`PUT /api/calls/{id}/captions`); every participant then sees "Captions on" and
  who turned them on. Each person can hide the captions on their own screen.
- **Workspace setting**: captions are off until an administrator allows them,
  and only offered when the installation has the service.
- Call notes (keeping the text, item 11) are a separate, also visible choice.

## Consequences

- Captions of a person whose app is older than this feature do not show; the
  caption bar says nothing about them rather than guessing.
- Accuracy depends on the model; the installer offers base (fast) and small
  (better Turkish). CPU use grows with the number of people speaking at once;
  the service takes one request at a time per CPU thread pool and the chat
  server drops audio when it falls behind (captions skip, the call does not).
- The media server is unchanged.
