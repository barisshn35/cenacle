// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import en from './en.json';
import tr from './tr.json';
import de from './de.json';
import fr from './fr.json';
import es from './es.json';
import ar from './ar.json';
import uiEn from '@cenacle/ui/i18n/en.json';
import uiTr from '@cenacle/ui/i18n/tr.json';
import uiDe from '@cenacle/ui/i18n/de.json';
import uiFr from '@cenacle/ui/i18n/fr.json';
import uiEs from '@cenacle/ui/i18n/es.json';
import uiAr from '@cenacle/ui/i18n/ar.json';
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

  // Languages with English's two plural forms have exactly its keys; Arabic
  // has CLDR's six forms (zero, one, two, few, many, other) for each plural.
  const ARABIC_PLURALS = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const arabicKeys = (english: string[]) =>
    english.flatMap((k) =>
      k.endsWith('_one')
        ? ARABIC_PLURALS.map((f) => k.replace(/_one$/, `_${f}`))
        : k.endsWith('_other')
          ? []
          : [k],
    );
  const placeholders = (v: string) => [...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  const flat = (tree: Tree, prefix = ''): Record<string, string> =>
    Object.fromEntries(
      Object.entries(tree).flatMap(([k, v]) =>
        typeof v === 'string' ? [[`${prefix}${k}`, v]] : Object.entries(flat(v, `${prefix}${k}.`)),
      ),
    );

  it.each([
    ['de', de, uiDe],
    ['fr', fr, uiFr],
    ['es', es, uiEs],
    ['ar', ar, uiAr],
  ])('%s has every key and the placeholders of English', (lng, app, ui) => {
    for (const [source, target] of [
      [en, app],
      [uiEn, ui],
    ] as [Tree, Tree][]) {
      const english = keys(source).sort();
      const want = lng === 'ar' ? arabicKeys(english).sort() : english;
      expect(keys(target).sort()).toEqual(want);
      const from = flat(source);
      for (const [k, v] of Object.entries(flat(target))) {
        const base = k.replace(/_(zero|one|two|few|many|other)$/, '');
        const original = from[k] ?? from[`${base}_other`] ?? '';
        // Arabic writes zero, one and two as words, without the count.
        const words = lng === 'ar' && /_(zero|one|two)$/.test(k);
        const want = placeholders(original).filter((p) => !(words && p === 'count'));
        expect(
          placeholders(v).filter((p) => !(words && p === 'count')),
          `${lng} ${k}`,
        ).toEqual(want);
      }
    }
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
