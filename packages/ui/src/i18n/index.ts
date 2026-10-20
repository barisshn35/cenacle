// SPDX-License-Identifier: Apache-2.0
import en from './en.json';
import tr from './tr.json';

/** i18next namespace used by @cenacle/ui components. */
export const UI_NAMESPACE = 'ui';

/** Resources to register with the app's i18next instance. */
export const uiResources = {
  en: { [UI_NAMESPACE]: en },
  tr: { [UI_NAMESPACE]: tr },
} as const;

export type UiMessages = typeof en;
