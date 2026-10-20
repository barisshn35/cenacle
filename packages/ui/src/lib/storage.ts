// SPDX-License-Identifier: Apache-2.0

/**
 * localStorage access that never throws (private mode, blocked storage,
 * sandboxed iframes). Values are per-device conveniences only.
 */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore: the preference simply is not persisted.
    }
  },
};
