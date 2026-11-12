# ADR 0053: Calls: recording with visible consent

Status: accepted (2026-11-12).

## Context

Some teams need a record of a call (training, a meeting someone missed). Until
now Cenacle said "Calls are not recorded". A recording holds everyone's voice and
picture, so it must never happen unnoticed, and it must follow the same rules as
other files (retention, legal hold, erasure, export).

## Decision

- **Off until allowed**: a workspace's administrators allow recording in its call
  settings (`calls_recording`). Until then the call view keeps saying that calls
  are not recorded.
- **Visible to everyone**: one person at a time starts recording
  (`PUT /api/calls/{id}/recording`); every participant sees a red "Recording" mark
  and who records, people joining see it before they join, and anyone in the call
  can stop it. The recording stops when its recorder leaves.
- **Recorded in the recorder's app**: the app composes what it receives (the
  shared screen large, else everyone's camera, a name card for those without one)
  on a canvas and mixes everyone's audio, and records them with MediaRecorder
  (WebM, VP8 and Opus, about 1 Mbit/s). No server component records media; the
  media server is unchanged.
- **Posted as a file**: when recording stops, the app uploads it into the call's
  channel like any file and posts it in a message. A recording larger than the
  installation's file size limit, or one whose upload fails, is offered to the
  recorder to save on their device instead.

## Consequences

- The recording is as good as the recorder's device and connection; in a
  background tab browsers draw the picture less often (sound is unaffected).
- Retention, legal hold, export and erasure apply to the file as to any other.
- The site and the privacy policy must describe recording as optional and
  visible (it was "never"); see the 1.0 site checklist.
