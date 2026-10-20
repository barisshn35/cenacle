// SPDX-License-Identifier: Apache-2.0
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { safeStorage } from '../lib/storage';
import { useMediaQuery } from '../hooks/use-media-query';
import {
  applyDensity,
  applyTheme,
  COARSE_QUERY,
  DARK_QUERY,
  DENSITY_STORAGE_KEY,
  readDensityPreference,
  readThemePreference,
  resolveDensity,
  resolveTheme,
  THEME_STORAGE_KEY,
  type DensityPreference,
  type ResolvedDensity,
  type ResolvedTheme,
  type ThemePreference,
} from './appearance';

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Used when nothing is stored. */
  defaultTheme?: ThemePreference;
  /** Forces a theme and ignores storage (e.g. gallery variants, tests). */
  forcedTheme?: ResolvedTheme;
}

/** Light/dark/system theme without next-themes; sets data-theme on <html>. */
export function ThemeProvider({
  children,
  defaultTheme = 'system',
  forcedTheme,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemePreference>(() => readThemePreference(defaultTheme));
  const systemDark = useMediaQuery(DARK_QUERY);
  const resolvedTheme = forcedTheme ?? resolveTheme(theme, systemDark);

  useLayoutEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    safeStorage.set(THEME_STORAGE_KEY, next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

interface DensityContextValue {
  density: DensityPreference;
  resolvedDensity: ResolvedDensity;
  setDensity: (density: DensityPreference) => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

export interface DensityProviderProps {
  children: ReactNode;
  defaultDensity?: DensityPreference;
  forcedDensity?: ResolvedDensity;
}

/** Compact/comfortable density; sets data-density on <html>. */
export function DensityProvider({
  children,
  defaultDensity = 'auto',
  forcedDensity,
}: DensityProviderProps) {
  const [density, setDensityState] = useState<DensityPreference>(() =>
    readDensityPreference(defaultDensity),
  );
  const coarse = useMediaQuery(COARSE_QUERY);
  const resolvedDensity = forcedDensity ?? resolveDensity(density, coarse);

  useLayoutEffect(() => {
    applyDensity(resolvedDensity);
  }, [resolvedDensity]);

  const setDensity = useCallback((next: DensityPreference) => {
    setDensityState(next);
    safeStorage.set(DENSITY_STORAGE_KEY, next);
  }, []);

  const value = useMemo(
    () => ({ density, resolvedDensity, setDensity }),
    [density, resolvedDensity, setDensity],
  );
  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

export function useDensity(): DensityContextValue {
  const ctx = useContext(DensityContext);
  if (!ctx) throw new Error('useDensity must be used within a DensityProvider');
  return ctx;
}
