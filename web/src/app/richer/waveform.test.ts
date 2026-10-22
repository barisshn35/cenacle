// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { toWaveform } from './waveform';

describe('toWaveform', () => {
  it('keeps at most 64 levels scaled to 0–255', () => {
    const levels = toWaveform(Array.from({ length: 1000 }, (_, i) => (i % 100) / 100));
    expect(levels).toHaveLength(64);
    expect(Math.max(...levels)).toBe(255);
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(0);
  });

  it('keeps short recordings as they are', () => {
    expect(toWaveform([0, 0.5, 1])).toEqual([0, 128, 255]);
    expect(toWaveform([])).toEqual([]);
  });
});
