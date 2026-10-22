// SPDX-License-Identifier: AGPL-3.0-only
import type { HighlighterCore, ThemedToken } from 'shiki/core';

/**
 * Code highlighting with shiki, loaded on first use: the JavaScript regex
 * engine (no WebAssembly, so the CSP needs nothing extra) and only the
 * languages that appear.
 */
const LANGUAGES: Record<string, () => Promise<unknown>> = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
};

const ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  cs: 'csharp',
  golang: 'go',
  docker: 'dockerfile',
  kt: 'kotlin',
};

/** The language a fence names, if it can be highlighted. */
export function languageOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lang = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  return lang in LANGUAGES ? lang : undefined;
}

let highlighter: Promise<HighlighterCore> | undefined;

/** Shiki themes, loaded when a code theme (Appearance) needs them. */
const THEMES: Record<string, () => Promise<unknown>> = {
  'github-light-high-contrast': () => import('@shikijs/themes/github-light-high-contrast'),
  'github-dark-high-contrast': () => import('@shikijs/themes/github-dark-high-contrast'),
  'github-light': () => import('@shikijs/themes/github-light'),
  'github-dark': () => import('@shikijs/themes/github-dark'),
  'one-light': () => import('@shikijs/themes/one-light'),
  'one-dark-pro': () => import('@shikijs/themes/one-dark-pro'),
  'solarized-light': () => import('@shikijs/themes/solarized-light'),
  'solarized-dark': () => import('@shikijs/themes/solarized-dark'),
  'catppuccin-latte': () => import('@shikijs/themes/catppuccin-latte'),
  'catppuccin-mocha': () => import('@shikijs/themes/catppuccin-mocha'),
  'vitesse-light': () => import('@shikijs/themes/vitesse-light'),
  'vitesse-dark': () => import('@shikijs/themes/vitesse-dark'),
};

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() }),
  );
  return highlighter;
}

export interface Line {
  tokens: { content: string; light?: string; dark?: string }[];
}

/** Tokens of code in both themes of a code theme (the page picks the colors). */
export async function highlight(
  code: string,
  lang: string,
  themes: readonly [string, string] = ['github-light-high-contrast', 'github-dark-high-contrast'],
): Promise<Line[]> {
  const h = await getHighlighter();
  if (!h.getLoadedLanguages().includes(lang)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await h.loadLanguage((await LANGUAGES[lang]!()) as any);
  }
  for (const theme of themes) {
    if (!h.getLoadedThemes().includes(theme)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await h.loadTheme((await THEMES[theme]!()) as any);
    }
  }
  const { tokens } = h.codeToTokens(code, {
    lang,
    themes: { light: themes[0], dark: themes[1] },
  });
  return tokens.map((line: ThemedToken[]) => ({
    tokens: line.map((t) => ({
      content: t.content,
      light: t.htmlStyle?.color,
      dark: t.htmlStyle?.['--shiki-dark'],
    })),
  }));
}
