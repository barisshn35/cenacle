// SPDX-License-Identifier: Apache-2.0
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { uiResources } from '@cenacle/ui/i18n';
import { safeStorage } from '@cenacle/ui/lib/storage';
import en from './en.json';
import tr from './tr.json';

export const LANGUAGES = ['en', 'tr'] as const;
export type Language = (typeof LANGUAGES)[number];

const STORAGE_KEY = 'cenacle.language';

export const resources = {
  en: { app: en, ...uiResources.en },
  tr: { app: tr, ...uiResources.tr },
} as const;

function isLanguage(v: unknown): v is Language {
  return LANGUAGES.includes(v as Language);
}

/** Stored choice, else the browser language, else English (the default). */
export function detectLanguage(): Language {
  const stored = safeStorage.get(STORAGE_KEY);
  if (isLanguage(stored)) return stored;
  const browser = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'en';
  return isLanguage(browser) ? browser : 'en';
}

export function setLanguage(lng: Language): void {
  safeStorage.set(STORAGE_KEY, lng);
  void i18next.changeLanguage(lng);
}

export function initI18n(lng: Language = detectLanguage()) {
  i18next.on('languageChanged', (l) => {
    document.documentElement.lang = l;
  });
  // Resources are bundled: no network requests for translations.
  return i18next.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    supportedLngs: LANGUAGES,
    resources,
    ns: ['app', 'ui'],
    defaultNS: 'app',
    interpolation: { escapeValue: false },
    returnNull: false,
    // Texts the administrators replaced arrive after start: show them at once.
    react: { bindI18nStore: 'added' },
  });
}

/** The bundled text of a key (what an administrator's text replaces). */
export function originalText(lng: Language, key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      resources[lng].app,
    );
  return typeof value === 'string' ? value : '';
}

/**
 * Applies the interface texts the administrators replaced (GET /api/ui-texts,
 * public, so the sign-in page uses them too); keys without one get their
 * bundled text back.
 */
export function applyUITexts(texts: Record<string, Record<string, string>>, keys: string[]) {
  for (const lng of LANGUAGES) {
    for (const key of keys) {
      i18next.addResource(lng, 'app', key, texts[lng]?.[key] || originalText(lng, key));
    }
  }
}

export async function loadUITexts(): Promise<void> {
  try {
    const res = await fetch('/api/ui-texts', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = (await res.json()) as {
      texts: Record<string, Record<string, string>>;
      editable: string[];
    };
    applyUITexts(body.texts, body.editable);
  } catch {
    // The bundled texts stay.
  }
}
