// SPDX-License-Identifier: AGPL-3.0-only
import i18n from 'i18next';

/** How clock times are shown: as the language does, or always 12 or 24 hour. */
export type TimeFormat = 'auto' | '12' | '24';

const KEY = 'cenacle.timeFormat';

export function getTimeFormat(): TimeFormat {
  try {
    const v = localStorage.getItem(KEY);
    return v === '12' || v === '24' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Saves the choice on this device and shows every time again in it. */
export function setTimeFormat(format: TimeFormat): void {
  try {
    if (format === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, format);
  } catch {
    // Storage may be blocked; the choice then lasts for this visit only.
    memory = format;
  }
  // Components that format times re-render on a language change.
  void i18n.changeLanguage(i18n.language);
}

let memory: TimeFormat | null = null;

/**
 * The locale for Intl.DateTimeFormat: the language with the hour cycle the
 * person chose (Unicode extension "hc"), so every clock time follows it.
 */
export function dateLocale(language?: string): string | undefined {
  const format = memory ?? getTimeFormat();
  const base = language ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
  if (format === 'auto' || !base) return base;
  return `${base}-u-hc-${format === '12' ? 'h12' : 'h23'}`;
}
