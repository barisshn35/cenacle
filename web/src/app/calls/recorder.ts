// SPDX-License-Identifier: AGPL-3.0-only
// Call recording (ADR 0053): the recorder's app draws what it receives on a
// canvas, mixes everyone's sound and records both. When it stops, the
// recording goes to the call's channel as a file (or to the recorder's device).
import i18next from 'i18next';
import { toast } from 'sonner';
import { apiFetch } from '@cenacle/core/api';
import { loadProfile } from '../profile/profiles';
import { uploadFile } from '../chat/files';
import { useCall } from './state';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 15;

function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
}

/** Whether this browser can record a call. */
export const canRecord = () => !!recorderType();

type Tile = { userID: string; track?: MediaStreamTrack; screen: boolean };

/** What the call shows now: the shared screen first, then cameras, then people. */
function tiles(selfID: string): Tile[] {
  const { call, tracks, local } = useCall.getState();
  const people = (call?.participants ?? []).filter((p) => p.state !== 'left' && p.user_id);
  const out: Tile[] = [];
  const screenOwn = local.get('screen');
  if (screenOwn) out.push({ userID: selfID, track: screenOwn, screen: true });
  for (const t of tracks)
    if (t.kind === 'screen' && t.track)
      out.push({ userID: t.user_id, track: t.track, screen: true });
  for (const p of people) {
    const id = p.user_id!;
    const camera =
      id === selfID
        ? local.get('camera')
        : tracks.find((t) => t.user_id === id && t.kind === 'camera' && t.track)?.track;
    out.push({ userID: id, track: camera, screen: false });
  }
  return out;
}

export interface Recording {
  stop: () => Promise<Blob>;
}

/** Starts recording the call as this app receives it. */
export function startRecording(selfID: string): Recording | null {
  const type = recorderType();
  if (!type) return null;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = canvas.getContext('2d')!;
  const videos = new Map<MediaStreamTrack, HTMLVideoElement>();
  const names = new Map<string, string>();
  const videoOf = (track: MediaStreamTrack) => {
    let v = videos.get(track);
    if (!v) {
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([track]);
      void v.play().catch(() => undefined);
      videos.set(track, v);
    }
    return v;
  };
  const nameOf = (id: string) => {
    if (!names.has(id)) {
      names.set(id, '');
      void loadProfile(id).then((p) => names.set(id, p?.display_name ?? ''));
    }
    return names.get(id) ?? '';
  };

  const drawTile = (t: Tile, x: number, y: number, w: number, h: number) => {
    g.fillStyle = '#14221d';
    g.fillRect(x, y, w, h);
    const v = t.track && t.track.readyState === 'live' ? videoOf(t.track) : null;
    if (v && v.videoWidth) {
      // Fit inside the tile, keeping the picture's shape.
      const scale = Math.min(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    const name = nameOf(t.userID);
    if (name) {
      g.font = '600 18px system-ui, sans-serif';
      const pad = 8;
      const tw = g.measureText(name).width;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x + pad, y + h - 34 - pad, tw + 16, 30);
      g.fillStyle = '#ece8dd';
      g.fillText(name, x + pad + 8, y + h - pad - 13);
    }
  };

  const draw = () => {
    g.fillStyle = '#0b1310';
    g.fillRect(0, 0, WIDTH, HEIGHT);
    const all = tiles(selfID);
    const screen = all.find((t) => t.screen);
    if (screen) {
      // The shared screen large, everyone else in a strip under it.
      const strip = all.filter((t) => !t.screen).slice(0, 6);
      const sh = strip.length ? 120 : 0;
      drawTile(screen, 0, 0, WIDTH, HEIGHT - sh);
      const w = strip.length ? WIDTH / strip.length : 0;
      strip.forEach((t, i) => drawTile(t, i * w + 2, HEIGHT - sh + 2, w - 4, sh - 4));
      return;
    }
    const n = Math.max(1, all.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = WIDTH / cols;
    const h = HEIGHT / rows;
    all.forEach((t, i) =>
      drawTile(t, (i % cols) * w + 2, Math.floor(i / cols) * h + 2, w - 4, h - 4),
    );
  };
  const timer = setInterval(draw, 1000 / FPS);
  draw();

  // Everyone's sound, mixed; sources follow people coming and going.
  const ctx = new AudioContext();
  // The recorder waits for sound: the context must run (it does after the click on Record).
  void ctx.resume().catch(() => undefined);
  const mix = ctx.createMediaStreamDestination();
  // A silent source keeps the audio track flowing: with no sound at all (nobody
  // speaking yet) the recorder would wait and write nothing.
  const silence = ctx.createConstantSource();
  silence.offset.value = 0;
  silence.connect(mix);
  silence.start();
  const sources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>();
  const syncAudio = () => {
    const { tracks, local } = useCall.getState();
    const wanted = new Set<MediaStreamTrack>();
    for (const t of tracks) if (t.kind === 'audio' && t.track) wanted.add(t.track);
    const own = local.get('audio');
    if (own) wanted.add(own);
    for (const track of wanted)
      if (!sources.has(track)) {
        const node = ctx.createMediaStreamSource(new MediaStream([track]));
        node.connect(mix);
        sources.set(track, node);
      }
    for (const [track, node] of sources)
      if (!wanted.has(track)) {
        node.disconnect();
        sources.delete(track);
      }
  };
  syncAudio();
  const unsubscribe = useCall.subscribe(syncAudio);

  const stream = new MediaStream([
    ...canvas.captureStream(FPS).getVideoTracks(),
    ...mix.stream.getAudioTracks(),
  ]);
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    videoBitsPerSecond: 1_000_000,
    audioBitsPerSecond: 64_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        const done = () => {
          clearInterval(timer);
          unsubscribe();
          stream.getTracks().forEach((t) => t.stop());
          for (const v of videos.values()) v.srcObject = null;
          void ctx.close();
          resolve(new Blob(chunks, { type: 'video/webm' }));
        };
        if (recorder.state === 'inactive') return done();
        recorder.onstop = done;
        recorder.stop();
      }),
  };
}

/** Saves a recording on this device (when it could not be posted). */
function saveLocally(file: File) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** Posts a finished recording into the call's channel, or offers to save it. */
export async function postRecording(channelID: string, blob: Blob): Promise<void> {
  if (blob.size === 0) return;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  const file = new File([blob], `${i18next.t('calls:recording.fileName')} ${stamp}.webm`, {
    type: 'video/webm',
  });
  const id = toast.loading(i18next.t('calls:recording.uploading'));
  try {
    const info = await uploadFile(channelID, file, () => undefined, new AbortController().signal);
    await apiFetch(`/api/channels/${channelID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: i18next.t('calls:recording.posted'),
        nonce: `rec-${crypto.randomUUID()}`,
        file_ids: [info.id],
      }),
    });
    toast.success(i18next.t('calls:recording.done'), { id });
  } catch {
    toast.error(i18next.t('calls:recording.failed'), {
      id,
      duration: Infinity,
      action: { label: i18next.t('calls:recording.save'), onClick: () => saveLocally(file) },
    });
  }
}
