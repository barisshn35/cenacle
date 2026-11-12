# ADR 0051: Calls: noise suppression and background blur

Status: accepted (2026-11-12).

## Context

People want calls to sound clean in a noisy room and to keep their background
private. Browsers already suppress some noise when a microphone is captured
(`noiseSuppression: true`, which `CallSession` asks for), but it leaves keyboard
clicks and steady hum, and no browser blurs a camera's background. Cenacle runs
without internet access and sends no media to a service, so both must work in the
browser and the desktop app, from files the installation serves.

## Decision

The work happens on the device, before the track is sent, through a `process`
hook of `CallSession` (packages/core): it gets the captured microphone or camera
track and returns the one to send and a way to stop it. Screens are never
processed.

- **Noise suppression**, three choices remembered per device: *Standard* (the
  browser's own, as before), *Strong* (RNNoise in an AudioWorklet, from
  `@sapphi-red/web-noise-suppressor` 0.4.1, MIT; RNNoise is BSD-3-Clause and its
  WebAssembly build Apache-2.0) and *Off* (for music: the browser's processing is
  turned off with `applyConstraints`).
- **Background blur**: MediaPipe's Image Segmenter (`@mediapipe/tasks-vision`
  1.2.0, Apache-2.0) with the Selfie Segmentation model (Apache-2.0), drawn on a
  canvas whose stream is sent. The person stays sharp, the rest is blurred.

The model (249 KB) is in the repository with its source and checksum
(`web/src/app/calls/models/README.md`). The WebAssembly files come from the
packages at build time and are emitted by Vite as ordinary assets; they are
fetched only when someone turns the feature on (about 14 MB for blur, under 1 MB
for strong noise suppression). Only the SIMD build of MediaPipe is shipped:
every browser Cenacle supports has WebAssembly SIMD.

The web app's Content-Security-Policy gains `'wasm-unsafe-eval'` in `script-src`:
it lets the page compile WebAssembly from its own origin; it does not allow
`eval` of JavaScript, and scripts still come only from the app's origin.

If either library fails to load or run, the call goes on with the captured
track as it is.

## Consequences

- No new server code; the media server sees ordinary tracks.
- Blur costs CPU (or GPU, when WebGL is available) on the sender's device; the
  setting says so and is off by default.
- The web image grows by about 15 MB of assets that are not loaded unless used.
- A later virtual background (an image instead of blur) reuses the same pipeline.
