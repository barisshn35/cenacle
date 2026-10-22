// SPDX-License-Identifier: AGPL-3.0-only
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach } from 'vitest';
import { uiResources } from '../src/i18n';

void i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: uiResources,
  ns: ['ui'],
  defaultNS: 'ui',
  interpolation: { escapeValue: false },
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});

// jsdom has no matchMedia; tests override it when they need a match.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom lacks pointer capture, which sonner uses for swipe-to-dismiss.
if (!('setPointerCapture' in HTMLElement.prototype)) {
  Object.assign(HTMLElement.prototype, {
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  });
}
