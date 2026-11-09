// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyCustomTheme,
  contrast,
  CUSTOM_RADII,
  CUSTOM_SURFACES,
  customThemeTokens,
  DEFAULT_CUSTOM_THEME,
  hexToOklch,
  isCustomTheme,
  oklchToHex,
  type CustomTheme,
} from '../src/theme/custom-theme';

// The pairs scripts/check-contrast.mjs holds every preset to that a custom
// theme sets (status colors stay those of tokens.css).
const PAIRS: [string, string, number][] = [
  ['--foreground', '--background', 4.5],
  ['--foreground', '--card', 4.5],
  ['--muted-foreground', '--background', 4.5],
  ['--muted-foreground', '--muted', 4.5],
  ['--muted-foreground', '--card', 4.5],
  ['--foreground', '--accent', 4.5],
  ['--foreground', '--secondary', 4.5],
  ['--accent-brand', '--background', 4.5],
  ['--accent-brand', '--card', 4.5],
  ['--accent-brand-foreground', '--accent-brand', 4.5],
  ['--sidebar-foreground', '--sidebar', 4.5],
  ['--sidebar-muted-foreground', '--sidebar', 4.5],
  ['--sidebar-accent-foreground', '--sidebar-accent', 4.5],
  ['--input', '--background', 3],
  ['--input', '--card', 3],
];
const STATUS = { light: ['#b42318'], dark: ['#ff8a80'] };

/** A repeatable stream of colors. */
function* colors(seed = 7): Generator<string> {
  let x = seed;
  for (;;) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    yield '#' + (x % 0xffffff).toString(16).padStart(6, '0');
  }
}

describe('custom theme', () => {
  it('converts colors to OKLCH and back', () => {
    for (const hex of ['#8f6b1f', '#14342b', '#ffffff', '#000000', '#0b5cad']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it('meets WCAG AA in both themes whatever is picked', () => {
    const pick = colors();
    for (let i = 0; i < 300; i++) {
      const t: CustomTheme = {
        accent: pick.next().value,
        sidebar: pick.next().value,
        surface: CUSTOM_SURFACES[i % CUSTOM_SURFACES.length]!,
        radius: CUSTOM_RADII[i % CUSTOM_RADII.length]!,
      };
      for (const mode of ['light', 'dark'] as const) {
        const tokens = customThemeTokens(t, mode);
        for (const [fg, bg, min] of PAIRS) {
          expect(
            contrast(tokens[fg]!, tokens[bg]!),
            `${fg} on ${bg} (${mode}, ${JSON.stringify(t)})`,
          ).toBeGreaterThanOrEqual(min);
        }
        for (const status of STATUS[mode]) {
          expect(contrast(status, tokens['--background']!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps a picked accent that already reads well', () => {
    expect(customThemeTokens(DEFAULT_CUSTOM_THEME, 'light')['--accent-brand']).toBe('#8f6b1f');
    expect(customThemeTokens(DEFAULT_CUSTOM_THEME, 'light')['--sidebar']).toBe('#14342b');
  });

  it('checks what it is given', () => {
    expect(isCustomTheme(DEFAULT_CUSTOM_THEME)).toBe(true);
    expect(isCustomTheme({ ...DEFAULT_CUSTOM_THEME, accent: 'red' })).toBe(false);
    expect(isCustomTheme({ ...DEFAULT_CUSTOM_THEME, surface: 'loud' })).toBe(false);
    expect(isCustomTheme(null)).toBe(false);
  });

  it('puts its style sheet into the page and takes it out', () => {
    applyCustomTheme(DEFAULT_CUSTOM_THEME);
    const el = document.getElementById('cenacle-custom-theme');
    expect(el?.textContent).toContain("[data-preset='custom'][data-theme='dark']");
    applyCustomTheme(null);
    expect(document.getElementById('cenacle-custom-theme')).toBeNull();
  });
});
