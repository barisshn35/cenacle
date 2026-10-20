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
  });
}
