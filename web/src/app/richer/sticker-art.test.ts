// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { captionSize, clampOffset, placement } from './sticker-art';

describe('placement', () => {
  it('fits a wide picture whole and centres it', () => {
    expect(placement(1000, 500, 1, { x: 0, y: 0 }, 500)).toEqual({ x: 0, y: 125, w: 500, h: 250 });
  });

  it('zooms around the centre and moves by the offset', () => {
    expect(placement(100, 100, 2, { x: 10, y: -20 }, 100)).toEqual({
      x: -40,
      y: -70,
      w: 200,
      h: 200,
    });
  });
});

describe('clampOffset', () => {
  it('keeps part of the picture in the square', () => {
    const o = clampOffset(100, 100, 1, { x: 9999, y: -9999 }, 512);
    expect(o).toEqual({ x: 512 - 48, y: -(512 - 48) });
  });

  it('leaves a small move alone', () => {
    expect(clampOffset(100, 100, 2, { x: 30, y: 40 })).toEqual({ x: 30, y: 40 });
  });
});

describe('captionSize', () => {
  it('uses the largest size that fits', () => {
    expect(captionSize(() => 10, 700)).toBe(100);
    expect(captionSize((px) => px * 10, 700)).toBe(64);
  });

  it('never goes below 12 pixels', () => {
    expect(captionSize(() => 1e6)).toBe(12);
  });
});
