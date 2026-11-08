// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moveLegacyData } from './legacy-data.js';

const appData = () => mkdtempSync(join(tmpdir(), 'cenacle-appdata-'));

describe('moveLegacyData', () => {
  it('moves the old folder to the new name once', () => {
    const root = appData();
    mkdirSync(join(root, '@cenacle', 'desktop'), { recursive: true });
    writeFileSync(join(root, '@cenacle', 'desktop', 'session.bin'), 'token');
    const now = join(root, 'Cenacle');
    expect(moveLegacyData(root, now)).toBe(true);
    expect(readFileSync(join(now, 'session.bin'), 'utf8')).toBe('token');
    expect(existsSync(join(root, '@cenacle'))).toBe(false);
    expect(moveLegacyData(root, now)).toBe(false);
  });

  it('leaves data already in the new folder alone', () => {
    const root = appData();
    mkdirSync(join(root, '@cenacle', 'desktop'), { recursive: true });
    mkdirSync(join(root, 'Cenacle'));
    writeFileSync(join(root, 'Cenacle', 'config.json'), '{}');
    expect(moveLegacyData(root, join(root, 'Cenacle'))).toBe(false);
    expect(existsSync(join(root, '@cenacle', 'desktop'))).toBe(true);
  });

  it('does nothing without old data', () => {
    expect(moveLegacyData(appData(), join(appData(), 'Cenacle'))).toBe(false);
  });
});
