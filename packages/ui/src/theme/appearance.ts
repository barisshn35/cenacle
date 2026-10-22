// SPDX-License-Identifier: AGPL-3.0-only
import { safeStorage } from '../lib/storage';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type DensityPreference = 'auto' | 'compact' | 'comfortable';
export type ResolvedDensity = 'compact' | 'comfortable';

export const THEME_STORAGE_KEY = 'cenacle.theme';
export const DENSITY_STORAGE_KEY = 'cenacle.density';

export const DARK_QUERY = '(prefers-color-scheme: dark)';
export const COARSE_QUERY = '(pointer: coarse)';

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function isDensityPreference(v: unknown): v is DensityPreference {
  return v === 'auto' || v === 'compact' || v === 'comfortable';
}

export function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/**
 * "auto" picks comfortable density on touch (coarse) pointers and compact on
 * mouse/trackpad. Target sizes never depend on density: they come from the
 * pointer type (28px fine, 44px coarse).
 */
export function resolveDensity(pref: DensityPreference, coarse: boolean): ResolvedDensity {
  if (pref === 'auto') return coarse ? 'comfortable' : 'compact';
  return pref;
}

export function readThemePreference(fallback: ThemePreference = 'system'): ThemePreference {
  const v = safeStorage.get(THEME_STORAGE_KEY);
  return isThemePreference(v) ? v : fallback;
}

export function readDensityPreference(fallback: DensityPreference = 'auto'): DensityPreference {
  const v = safeStorage.get(DENSITY_STORAGE_KEY);
  return isDensityPreference(v) ? v : fallback;
}

export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement) {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function applyDensity(
  density: ResolvedDensity,
  root: HTMLElement = document.documentElement,
) {
  root.dataset.density = density;
}

/**
 * Applies stored preferences synchronously. Call before the first render to
 * avoid a flash of the wrong theme.
 */
export function applyStoredAppearance(root: HTMLElement = document.documentElement): void {
  applyTheme(resolveTheme(readThemePreference(), matches(DARK_QUERY)), root);
  applyDensity(resolveDensity(readDensityPreference(), matches(COARSE_QUERY)), root);
}
