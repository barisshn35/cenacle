// SPDX-License-Identifier: AGPL-3.0-only
import ar from './ar.json';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import tr from './tr.json';

/** i18next namespace used by @cenacle/ui components. */
export const UI_NAMESPACE = 'ui';

/** Resources to register with the app's i18next instance. */
export const uiResources = {
  en: { [UI_NAMESPACE]: en },
  tr: { [UI_NAMESPACE]: tr },
  de: { [UI_NAMESPACE]: de },
  fr: { [UI_NAMESPACE]: fr },
  es: { [UI_NAMESPACE]: es },
  ar: { [UI_NAMESPACE]: ar },
} as const;

export type UiMessages = typeof en;
