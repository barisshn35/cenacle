// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import tr from '../../i18n/tr.json';
import { BUILTIN_SOUNDS, SOUNDS } from './sounds';

describe('built-in sounds', () => {
  it('offers more than twenty, each with notes and a name in every language', () => {
    expect(BUILTIN_SOUNDS.length).toBeGreaterThan(20);
    expect(new Set(BUILTIN_SOUNDS).size).toBe(BUILTIN_SOUNDS.length);
    for (const id of BUILTIN_SOUNDS) {
      expect(SOUNDS[id].length, id).toBeGreaterThan(0);
      for (const n of SOUNDS[id]) expect(n.at + n.dur, id).toBeLessThanOrEqual(1.5);
      expect((en.notifications.sounds as Record<string, string>)[id], id).toBeTruthy();
      expect((tr.notifications.sounds as Record<string, string>)[id], id).toBeTruthy();
    }
  });
});
