// SPDX-License-Identifier: AGPL-3.0-only
// Live captions (ADR 0052): while captions are on, this app sends what its own
// person says, between pauses, to be written out for everyone in the call.
// Nothing is sent while they are quiet.
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@cenacle/core/api';
import { channelsQuery } from '../chat/data';
import { callSettingsQuery, useCall } from './state';

/** A pause this long ends an utterance. */
const PAUSE_MS = 700;
/** Utterances are cut at this length (the server takes up to 12 s). */
const MAX_MS = 11_000;
/** Shorter sounds (a cough, a click) are not sent. */
const MIN_MS = 600;
const TICK_MS = 50;

function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
}

/** Whether this browser can send its speech for captions. */
export const canSendCaptions = () => !!recorderType();

/**
 * Listens to the microphone track that the call sends and posts each
 * utterance; returns a function that stops it.
 */
export function startCaptionSender(
  track: MediaStreamTrack,
  callID: string,
  language: 'tr' | 'en' | 'auto',
): () => void {
  const type = recorderType();
  if (!type) return () => undefined;
  const stream = new MediaStream([track]);
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  // The room's own level, learned while quiet: speech is well above it.
  let floor = 0.01;
  let recorder: MediaRecorder | null = null;
  let started = 0;
  let lastVoice = 0;
  let stopped = false;

  const send = (blob: Blob, length: number) => {
    if (length < MIN_MS || stopped) return;
    void apiFetch<void>(
      `/api/calls/${encodeURIComponent(callID)}/captions/audio?language=${language}`,
      { method: 'POST', headers: { 'Content-Type': type.split(';')[0]! }, body: blob },
    ).catch(() => undefined); // a lost caption is skipped; the call goes on
  };

  const finish = () => {
    const r = recorder;
    if (!r) return;
    recorder = null;
    const length = performance.now() - started;
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = () => send(new Blob(chunks, { type }), length);
    if (r.state !== 'inactive') r.stop();
  };

  const timer = setInterval(() => {
    if (track.readyState !== 'live' || !track.enabled) return finish();
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    const level = Math.sqrt(sum / samples.length);
    const now = performance.now();
    const voice = level > Math.max(0.02, floor * 3);
    if (!voice && !recorder) floor = floor * 0.95 + level * 0.05;
    if (voice) lastVoice = now;
    if (voice && !recorder) {
      recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32_000 });
      started = now;
      recorder.start();
    } else if (recorder && (now - lastVoice > PAUSE_MS || now - started > MAX_MS)) {
      finish();
    }
  }, TICK_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorder = null;
    void ctx.close();
  };
}

/** Live captions are allowed in this call's workspace and offered by the installation. */
export function useCaptionsAllowed(): boolean {
  const channelID = useCall((s) => s.call?.channel_id);
  const workspace = useQuery(channelsQuery).data?.find((c) => c.id === channelID)?.workspace_id;
  const settings = useQuery(callSettingsQuery(workspace ?? '')).data;
  return !!settings?.captions && !!settings.captions_available;
}

/** Call notes are allowed (they need captions). */
export function useNotesAllowed(): boolean {
  const channelID = useCall((s) => s.call?.channel_id);
  const workspace = useQuery(channelsQuery).data?.find((c) => c.id === channelID)?.workspace_id;
  const settings = useQuery(callSettingsQuery(workspace ?? '')).data;
  return !!settings?.notes && !!settings.captions && !!settings.captions_available;
}

/** Calls may be recorded in this workspace (visibly to everyone). */
export function useRecordingAllowed(): boolean {
  const channelID = useCall((s) => s.call?.channel_id);
  const workspace = useQuery(channelsQuery).data?.find((c) => c.id === channelID)?.workspace_id;
  return !!useQuery(callSettingsQuery(workspace ?? '')).data?.recording;
}
