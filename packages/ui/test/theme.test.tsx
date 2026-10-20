// SPDX-License-Identifier: Apache-2.0
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  applyStoredAppearance,
  DensityProvider,
  resolveDensity,
  resolveTheme,
  ThemeProvider,
  useDensity,
  useTheme,
} from '../src/theme';

function mockMedia(matching: string[]) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: matching.includes(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { density, resolvedDensity, setDensity } = useDensity();
  return (
    <div>
      <span data-testid="theme">{`${theme}:${resolvedTheme}`}</span>
      <span data-testid="density">{`${density}:${resolvedDensity}`}</span>
      <button onClick={() => setTheme('dark')}>dark</button>
      <button onClick={() => setDensity('comfortable')}>comfortable</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <DensityProvider>
        <Probe />
      </DensityProvider>
    </ThemeProvider>,
  );
}

describe('appearance resolution', () => {
  it('resolves system theme from the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('uses comfortable density automatically on coarse pointers', () => {
    expect(resolveDensity('auto', true)).toBe('comfortable');
    expect(resolveDensity('auto', false)).toBe('compact');
    expect(resolveDensity('compact', true)).toBe('compact');
  });
});

describe('ThemeProvider and DensityProvider', () => {
  it('applies system theme and auto density to <html>', () => {
    mockMedia(['(prefers-color-scheme: dark)']);
    renderProbe();
    expect(screen.getByTestId('theme')).toHaveTextContent('system:dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('persists user choices', () => {
    mockMedia([]);
    renderProbe();
    act(() => screen.getByText('dark').click());
    act(() => screen.getByText('comfortable').click());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(localStorage.getItem('cenacle.theme')).toBe('dark');
    expect(localStorage.getItem('cenacle.density')).toBe('comfortable');
  });

  it('restores stored preferences before first render', () => {
    mockMedia(['(pointer: coarse)']);
    localStorage.setItem('cenacle.theme', 'dark');
    applyStoredAppearance();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('comfortable');
  });

  it('ignores invalid stored values', () => {
    mockMedia([]);
    localStorage.setItem('cenacle.theme', 'neon');
    renderProbe();
    expect(screen.getByTestId('theme')).toHaveTextContent('system:light');
  });
});
