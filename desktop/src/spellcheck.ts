// SPDX-License-Identifier: AGPL-3.0-only
// Spell checking with the dictionaries that come with the app: nothing is
// downloaded. Electron would otherwise fetch the dictionary of the system's
// language from Google the first time it checks a word.
import { app, session, type Session } from 'electron';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The dictionary files Chromium looks for, by spell checker language. */
export const DICTIONARIES: Readonly<Record<string, string>> = {
  'en-US': 'en-US-10-1.bdic',
  tr: 'tr-TR-4-0.bdic',
};

/**
 * Where Chromium fetches a dictionary it does not have: a closed port on this
 * computer, so a missing one is never asked of anyone.
 */
export const NOWHERE = 'http://127.0.0.1:9/';

const bundled = () =>
  app.isPackaged
    ? join(process.resourcesPath, 'dictionaries')
    : join(app.getAppPath(), 'dictionaries');

/**
 * Puts the app's dictionaries where Chromium reads them (the Dictionaries folder of
 * the app's data) and returns the languages that have one there: those that come
 * with the app, and one downloaded by an older version.
 */
export function prepareDictionaries(
  from = bundled(),
  to = join(app.getPath('userData'), 'Dictionaries'),
): string[] {
  mkdirSync(to, { recursive: true });
  const ready: string[] = [];
  for (const [lang, file] of Object.entries(DICTIONARIES)) {
    const source = join(from, file);
    const target = join(to, file);
    try {
      if (
        existsSync(source) &&
        (!existsSync(target) || statSync(target).size !== statSync(source).size)
      ) {
        copyFileSync(source, target);
      }
    } catch {
      // A read-only or full disk: spell checking goes without this language.
    }
    if (existsSync(target)) ready.push(lang);
  }
  return ready;
}

/**
 * The languages to check, from the system's preferred languages: Turkish and
 * English when there is a dictionary for them. The first language decides: when
 * there is no dictionary for it, nothing is checked rather than marking every word
 * of it as misspelled. Without any preferred language, English (the app's language).
 */
export function chooseLanguages(preferred: readonly string[], ready: readonly string[]): string[] {
  const wanted = preferred.map((l) =>
    l.toLowerCase().startsWith('tr') ? 'tr' : l.toLowerCase().startsWith('en') ? 'en-US' : '',
  );
  const first = wanted[0];
  if (first === undefined) return ready.includes('en-US') ? ['en-US'] : [];
  if (!ready.includes(first)) return [];
  return [...new Set(wanted.filter((l) => l && ready.includes(l)))];
}

function configure(ses: Session, languages: string[]) {
  ses.setSpellCheckerDictionaryDownloadURL(NOWHERE);
  ses.setSpellCheckerLanguages(languages);
}

/** Sets up spell checking for every session of the app (call before any window). */
export function setUpSpellChecking() {
  const languages = chooseLanguages(app.getPreferredSystemLanguages(), prepareDictionaries());
  app.on('session-created', (ses) => configure(ses, languages));
  configure(session.defaultSession, languages);
}
