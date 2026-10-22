// SPDX-License-Identifier: AGPL-3.0-only

/** Levels kept for a voice message's waveform. */
const LEVELS = 64;

/** Reduces sampled levels (0–1) to at most LEVELS values of 0–255. */
export function toWaveform(samples: number[]): number[] {
  if (samples.length === 0) return [];
  const n = Math.min(LEVELS, samples.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * samples.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / n));
    const slice = samples.slice(from, to);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const peak = Math.max(...out, 0.01);
  return out.map((v) => Math.round((v / peak) * 255));
}
