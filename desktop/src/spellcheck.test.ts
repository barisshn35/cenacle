// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, session: {} }));
const { chooseLanguages, prepareDictionaries, DICTIONARIES } = await import('./spellcheck.js');

describe('chooseLanguages', () => {
  it('checks the system language when its dictionary is there', () => {
    expect(chooseLanguages(['tr-TR', 'tr'], ['en-US', 'tr'])).toEqual(['tr']);
    expect(chooseLanguages(['en-GB', 'en'], ['en-US', 'tr'])).toEqual(['en-US']);
    expect(chooseLanguages(['tr-TR', 'en-US'], ['en-US', 'tr'])).toEqual(['tr', 'en-US']);
  });

  it('checks nothing when the first language has no dictionary', () => {
    expect(chooseLanguages(['de-DE', 'de'], ['en-US'])).toEqual([]);
    expect(chooseLanguages(['de-DE', 'en-US'], ['en-US'])).toEqual([]);
    expect(chooseLanguages(['tr-TR', 'en-US'], ['en-US'])).toEqual([]);
  });

  it('checks English without any preferred language', () => {
    expect(chooseLanguages([], ['en-US'])).toEqual(['en-US']);
  });

  it('adds later languages that have a dictionary', () => {
    expect(chooseLanguages(['en-US', 'de-DE', 'tr-TR'], ['en-US', 'tr'])).toEqual(['en-US', 'tr']);
  });

  it('checks nothing on a Turkish system without the Turkish dictionary', () => {
    expect(chooseLanguages(['tr-TR', 'tr'], ['en-US'])).toEqual([]);
  });

  it('checks nothing without dictionaries', () => {
    expect(chooseLanguages(['de-DE'], [])).toEqual([]);
  });
});

describe('prepareDictionaries', () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), 'spellcheck-'));
    const from = join(root, 'bundled');
    const to = join(root, 'Dictionaries');
    mkdirSync(from);
    mkdirSync(to);
    return { from, to };
  };

  it('copies the dictionaries that come with the app', () => {
    const { from, to } = dirs();
    writeFileSync(join(from, DICTIONARIES['en-US']!), 'en');
    expect(prepareDictionaries(from, to)).toEqual(['en-US']);
    expect(readFileSync(join(to, DICTIONARIES['en-US']!), 'utf8')).toBe('en');
  });

  it('keeps a dictionary an older version downloaded, and replaces one that differs', () => {
    const { from, to } = dirs();
    writeFileSync(join(from, DICTIONARIES['en-US']!), 'english');
    writeFileSync(join(to, DICTIONARIES['en-US']!), 'old');
    writeFileSync(join(to, DICTIONARIES.tr!), 'turkish');
    expect(prepareDictionaries(from, to)).toEqual(['en-US', 'tr']);
    expect(readFileSync(join(to, DICTIONARIES['en-US']!), 'utf8')).toBe('english');
    expect(readFileSync(join(to, DICTIONARIES.tr!), 'utf8')).toBe('turkish');
    expect(readdirSync(to).sort()).toEqual([DICTIONARIES['en-US'], DICTIONARIES.tr].sort());
  });
});
