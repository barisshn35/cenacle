// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { encodeGif, frameTimes, gifSize } from './gif-art';

describe('gifSize', () => {
  it('keeps the shape and never grows the video', () => {
    expect(gifSize(1920, 1080, 320)).toEqual({ w: 320, h: 180 });
    expect(gifSize(200, 100, 480)).toEqual({ w: 200, h: 100 });
  });
});

describe('frameTimes', () => {
  it('takes fps frames a second from the start', () => {
    expect(frameTimes(1, 1, 4, 10)).toEqual([1, 1.25, 1.5, 1.75]);
  });

  it('stays within the video and the longest length', () => {
    expect(frameTimes(9.5, 3, 2, 10)).toEqual([9.5]);
    expect(frameTimes(0, 60, 10, 100)).toHaveLength(100);
  });
});

describe('encodeGif', () => {
  it('makes a looping GIF of the frames', async () => {
    const progress: number[] = [];
    const bytes = await encodeGif({
      count: 2,
      width: 2,
      height: 2,
      fps: 10,
      frame: async (i) => new Uint8ClampedArray(16).fill(i ? 255 : 0),
      onProgress: (f) => progress.push(f),
    });
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('GIF89a');
    expect(progress).toEqual([0.5, 1]);
  });

  it('stops when cancelled', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(
      encodeGif({
        count: 1,
        width: 1,
        height: 1,
        fps: 10,
        frame: async () => new Uint8ClampedArray(4),
        signal: stop.signal,
      }),
    ).rejects.toThrow();
  });
});
