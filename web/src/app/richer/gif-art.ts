// SPDX-License-Identifier: AGPL-3.0-only
import { applyPalette, GIFEncoder, quantize } from 'gifenc';

/** How long a GIF made from a video may be, in seconds. */
export const MIN_SECONDS = 0.5;
export const MAX_SECONDS = 10;
/** The widths and frame rates on offer. */
export const GIF_WIDTHS = [240, 320, 480] as const;
export const GIF_FPS = [10, 15, 20] as const;

/** The GIF's size: the chosen width (never wider than the video), keeping its shape. */
export function gifSize(videoWidth: number, videoHeight: number, width: number) {
  const w = Math.max(2, Math.min(width, videoWidth));
  const h = Math.max(2, Math.round((videoHeight * w) / videoWidth));
  return { w, h };
}

/** The moments of the video the frames show: from `start`, `fps` a second, within the video. */
export function frameTimes(start: number, length: number, fps: number, duration: number): number[] {
  const from = Math.max(0, Math.min(start, duration));
  const to = Math.min(from + Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, length)), duration);
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const t = from + i / fps;
    if (t >= to - 1e-6 && out.length > 0) break;
    out.push(Math.round(t * 1000) / 1000);
    if (t >= to) break;
  }
  return out;
}

/**
 * Encodes frames into a looping GIF, each with its own palette. `frame(i)`
 * gives the RGBA pixels of frame i; awaiting it between frames keeps the page
 * responsive. Stops with an AbortError when the signal is aborted.
 */
export async function encodeGif(opts: {
  count: number;
  width: number;
  height: number;
  fps: number;
  frame: (i: number) => Promise<Uint8ClampedArray>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / opts.fps);
  for (let i = 0; i < opts.count; i++) {
    opts.signal?.throwIfAborted();
    const rgba = await opts.frame(i);
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), opts.width, opts.height, {
      palette,
      delay,
      repeat: 0,
    });
    opts.onProgress?.((i + 1) / opts.count);
  }
  gif.finish();
  return gif.bytes();
}
