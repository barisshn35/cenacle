// SPDX-License-Identifier: AGPL-3.0-only
// Noise suppression and background blur for calls (ADR 0051): the captured
// microphone or camera track is worked on here, on the device, and the result
// is what the call sends. Everything is fetched from the app's own origin,
// only when someone turns it on.
import { create } from 'zustand';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import visionLoader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import visionWasm from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import selfieModel from './models/selfie_segmenter.tflite?url';

/** standard: the browser's own; strong: RNNoise; off: none (music). */
export type NoiseMode = 'standard' | 'strong' | 'off';
export type BackgroundMode = 'none' | 'blur';

export interface Effects {
  noise: NoiseMode;
  background: BackgroundMode;
}

const KEY = 'cenacle.call.effects';
const DEFAULTS: Effects = { noise: 'standard', background: 'none' };

function load(): Effects {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Effects>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** The effects chosen on this device. */
export const useEffects = create<Effects>()(() => load());

export function setEffects(patch: Partial<Effects>): void {
  useEffects.setState(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(useEffects.getState()));
  } catch {
    // Private windows: the choice holds until the page closes.
  }
}

type Worked = { track: MediaStreamTrack; stop: () => void };

/** RNNoise between the microphone and the call. */
async function suppressNoise(track: MediaStreamTrack): Promise<Worked> {
  const { loadRnnoise, RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
  // RNNoise works at 48 kHz.
  const ctx = new AudioContext({ sampleRate: 48000 });
  try {
    const [wasmBinary] = await Promise.all([
      loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }),
      ctx.audioWorklet.addModule(rnnoiseWorklet),
    ]);
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const out = ctx.createMediaStreamDestination();
    source.connect(node).connect(out);
    return {
      track: out.stream.getAudioTracks()[0]!,
      stop: () => {
        node.destroy();
        void ctx.close();
      },
    };
  } catch (error) {
    void ctx.close();
    throw error;
  }
}

/** The camera with its background blurred (the person stays sharp). */
async function blurBackground(track: MediaStreamTrack): Promise<Worked> {
  const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
  const segmenter = await ImageSegmenter.createFromOptions(
    { wasmLoaderPath: visionLoader, wasmBinaryPath: visionWasm },
    {
      baseOptions: { modelAssetPath: selfieModel, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    },
  );
  const { width = 1280, height = 720, frameRate = 30 } = track.getSettings();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const out = canvas.getContext('2d')!;
  const mask = document.createElement('canvas');
  const maskCtx = mask.getContext('2d')!;
  /** One frame: the person from the mask, sharp, over the blurred frame. */
  const render = (source: CanvasImageSource & TexImageSource, at: number) => {
    const result = segmenter.segmentForVideo(source as HTMLVideoElement, at);
    const confidence = result.confidenceMasks?.[0];
    if (confidence) {
      const values = confidence.getAsFloat32Array();
      if (mask.width !== confidence.width || mask.height !== confidence.height) {
        mask.width = confidence.width;
        mask.height = confidence.height;
      }
      const pixels = maskCtx.createImageData(mask.width, mask.height);
      for (let i = 0; i < values.length; i++) pixels.data[i * 4 + 3] = values[i]! * 255;
      maskCtx.putImageData(pixels, 0, 0);
      out.save();
      out.clearRect(0, 0, width, height);
      out.drawImage(source, 0, 0, width, height);
      out.globalCompositeOperation = 'destination-in';
      out.drawImage(mask, 0, 0, width, height);
      out.globalCompositeOperation = 'destination-over';
      out.filter = 'blur(14px)';
      out.drawImage(source, 0, 0, width, height);
      out.restore();
    }
    result.close();
  };

  // Chromium (and the desktop app) works frame by frame, also while the tab is
  // in the background; elsewhere a hidden video is drawn on each animation frame.
  const w = window as unknown as {
    MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>;
    };
    MediaStreamTrackGenerator?: new (o: { kind: 'video' }) => MediaStreamTrack & {
      writable: WritableStream<VideoFrame>;
    };
  };
  if (w.MediaStreamTrackProcessor && w.MediaStreamTrackGenerator) {
    const processor = new w.MediaStreamTrackProcessor({ track });
    const generator = new w.MediaStreamTrackGenerator({ kind: 'video' });
    const abort = new AbortController();
    void processor.readable
      .pipeThrough(
        new TransformStream<VideoFrame, VideoFrame>({
          transform(frame, controller) {
            try {
              render(frame, frame.timestamp / 1000);
              controller.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp }));
            } finally {
              frame.close();
            }
          },
        }),
        { signal: abort.signal },
      )
      .pipeTo(generator.writable, { signal: abort.signal })
      .catch(() => undefined);
    return {
      track: generator,
      stop: () => {
        abort.abort();
        segmenter.close();
      },
    };
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play();
  let stopped = false;
  let last = -1;
  const draw = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.currentTime !== last) {
      last = video.currentTime;
      render(video, performance.now());
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return {
    track: canvas.captureStream(frameRate).getVideoTracks()[0]!,
    stop: () => {
      stopped = true;
      video.srcObject = null;
      segmenter.close();
    },
  };
}

/**
 * CallSession's `process` hook: the chosen effects on a captured track. A
 * failure is the caller's to swallow (the plain track is sent).
 */
export async function processTrack(
  kind: 'audio' | 'camera',
  track: MediaStreamTrack,
): Promise<Worked> {
  const { noise, background } = useEffects.getState();
  if (kind === 'audio') {
    if (noise === 'strong') return suppressNoise(track);
    if (noise === 'off')
      await track
        .applyConstraints({
          noiseSuppression: false,
          echoCancellation: true,
          autoGainControl: false,
        })
        .catch(() => undefined);
    return { track, stop: () => undefined };
  }
  if (background === 'blur') return blurBackground(track);
  return { track, stop: () => undefined };
}
