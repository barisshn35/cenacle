// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import en from './en.json';
import tr from './tr.json';
import uiEn from '@cenacle/ui/i18n/en.json';
import uiTr from '@cenacle/ui/i18n/tr.json';
import devEn from '../dev/i18n/en.json';
import devTr from '../dev/i18n/tr.json';

type Tree = { [k: string]: string | Tree };

function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
  );
}

function values(tree: Tree): string[] {
  return Object.values(tree).flatMap((v) => (typeof v === 'string' ? [v] : values(v)));
}

describe('translations', () => {
  it.each([
    ['app', en, tr],
    ['ui', uiEn, uiTr],
    ['dev', devEn, devTr],
  ])('%s: English and Turkish have the same keys', (_ns, a, b) => {
    expect(keys(b as Tree).sort()).toEqual(keys(a as Tree).sort());
  });

  // Glossary rules (docs/ux/glossary.md).
  it('uses the glossary terms', () => {
    expect(en.glossary.workspace).toBe('Workspace');
    expect(tr.glossary.workspace).toBe('Çalışma alanı');
    expect(tr.glossary.rotateToken).toBe("Token'ı yenile");
  });

  it.each([
    ['en', [...values(en as Tree), ...values(uiEn as Tree)], [/\breset\b/i, /^(OK|Yes)$/]],
    ['tr', [...values(tr as Tree), ...values(uiTr as Tree)], [/sıfırla/i, /^(Tamam|Evet)$/]],
  ])('%s texts avoid forbidden wording', (_lng, texts, forbidden) => {
    for (const text of texts) {
      for (const re of forbidden) expect(text, text).not.toMatch(re);
    }
  });
});
