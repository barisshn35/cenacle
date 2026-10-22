// SPDX-License-Identifier: AGPL-3.0-only
// The appearance choices (v0.16, ADR 0013/0019): theme presets, the font
// library, font templates and code themes, and applying a person's settings
// to the page.

export const THEME_PRESETS = [
  'cenacle',
  'graphite',
  'ocean',
  'forest',
  'sunset',
  'rose',
  'contrast',
] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

/** The accent of each preset, for the swatches of the picker (light, dark). */
export const PRESET_SWATCHES: Record<ThemePreset, [string, string]> = {
  cenacle: ['#8f6b1f', '#c9a24b'],
  graphite: ['#3f3f46', '#d4d4d8'],
  ocean: ['#0b5cad', '#6cb4ff'],
  forest: ['#1f7a4d', '#5fd39a'],
  sunset: ['#b0420a', '#ff9a5c'],
  rose: ['#b0245c', '#ff8fb8'],
  contrast: ['#0033b3', '#ffd400'],
};

export interface LibraryFont {
  id: string;
  name: string;
  family: string;
  kind: 'text' | 'code';
}

const text = (id: string, name: string, family = `${name} Variable`): LibraryFont => ({
  id,
  name,
  family,
  kind: 'text',
});
const code = (id: string, name: string, family = `${name} Variable`): LibraryFont => ({
  id,
  name,
  family,
  kind: 'code',
});

export const FONT_LIBRARY: LibraryFont[] = [
  text('inter', 'Inter'),
  text('ibm-plex-sans', 'IBM Plex Sans'),
  text('geist', 'Geist'),
  text('manrope', 'Manrope'),
  text('source-sans-3', 'Source Sans 3'),
  text('figtree', 'Figtree'),
  text('public-sans', 'Public Sans'),
  text('plus-jakarta-sans', 'Plus Jakarta Sans'),
  text('noto-sans', 'Noto Sans'),
  text('atkinson-hyperlegible-next', 'Atkinson Hyperlegible Next'),
  code('jetbrains-mono', 'JetBrains Mono'),
  code('ibm-plex-mono', 'IBM Plex Mono', 'IBM Plex Mono'),
  code('geist-mono', 'Geist Mono'),
  code('fira-code', 'Fira Code'),
  code('source-code-pro', 'Source Code Pro'),
  code('cascadia-code', 'Cascadia Code'),
  code('roboto-mono', 'Roboto Mono'),
  code('red-hat-mono', 'Red Hat Mono'),
  code('noto-sans-mono', 'Noto Sans Mono'),
  code('commit-mono', 'Commit Mono', 'Commit Mono'),
];

export const FONT_TEMPLATES = {
  corporate: { text: 'inter', code: 'jetbrains-mono' },
  classic: { text: 'ibm-plex-sans', code: 'ibm-plex-mono' },
  modern: { text: 'geist', code: 'geist-mono' },
  product: { text: 'manrope', code: 'fira-code' },
  reading: { text: 'source-sans-3', code: 'source-code-pro' },
  legible: { text: 'atkinson-hyperlegible-next', code: 'red-hat-mono' },
} as const;
export type FontTemplate = keyof typeof FONT_TEMPLATES;

/** Code themes: shiki theme names for light and dark. */
export const CODE_THEMES = {
  github: ['github-light-high-contrast', 'github-dark-high-contrast'],
  'github-soft': ['github-light', 'github-dark'],
  one: ['one-light', 'one-dark-pro'],
  solarized: ['solarized-light', 'solarized-dark'],
  catppuccin: ['catppuccin-latte', 'catppuccin-mocha'],
  vitesse: ['vitesse-light', 'vitesse-dark'],
} as const;
export type CodeTheme = keyof typeof CODE_THEMES;

const SANS_FALLBACK = 'ui-sans-serif, system-ui, sans-serif';
const MONO_FALLBACK = 'ui-monospace, monospace';
const LINE_HEIGHTS = { compact: '1.45', normal: '1.625', relaxed: '1.8' } as const;

/** What the page needs to show a person's appearance. */
export interface ResolvedAppearance {
  preset: ThemePreset;
  /** CSS font-family names (a library family or an uploaded font's). */
  textFamily: string;
  codeFamily: string;
  fontSize: number;
  lineHeight: keyof typeof LINE_HEIGHTS;
  ligatures: boolean;
}

export function familyOf(id: string, kind: 'text' | 'code'): string {
  if (id.startsWith('user:')) return `cenacle-user-${id.slice(5)}`;
  const font = FONT_LIBRARY.find((f) => f.id === id && f.kind === kind);
  return font?.family ?? (kind === 'text' ? 'Inter Variable' : 'JetBrains Mono Variable');
}

/** Applies an appearance to <html>: preset, fonts, size and line height. */
export function applyResolvedAppearance(
  a: ResolvedAppearance,
  root: HTMLElement = document.documentElement,
): void {
  if (a.preset === 'cenacle') delete root.dataset.preset;
  else root.dataset.preset = a.preset;
  root.style.setProperty('--font-sans', `'${a.textFamily}', ${SANS_FALLBACK}`);
  root.style.setProperty('--font-mono', `'${a.codeFamily}', ${MONO_FALLBACK}`);
  root.style.setProperty('--code-ligatures', a.ligatures ? 'normal' : 'none');
  // 14 is the design size: the whole interface scales from it.
  root.style.fontSize = a.fontSize === 14 ? '' : `${(a.fontSize / 14) * 100}%`;
  root.style.setProperty('--line-height-base', LINE_HEIGHTS[a.lineHeight]);
}
