// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
const { centredOver } = await import('./chrome');

describe('centredOver', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  it('puts a window over the middle of another', () => {
    expect(centredOver({ x: 100, y: 100, width: 1200, height: 800 }, 520, 720, area)).toEqual({
      x: 440,
      y: 140,
    });
  });
  it('keeps it on the screen when the other is near an edge', () => {
    expect(centredOver({ x: 1700, y: 900, width: 400, height: 300 }, 520, 720, area)).toEqual({
      x: 1400,
      y: 320,
    });
    expect(centredOver({ x: -300, y: -50, width: 400, height: 300 }, 520, 720, area)).toEqual({
      x: 0,
      y: 0,
    });
  });
});
