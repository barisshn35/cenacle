#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Checks WCAG 2.2 contrast of the design tokens in both themes
// (packages/ui/src/styles/tokens.css): text pairs need 4.5:1 (1.4.3), UI
// component pairs such as focus rings and control outlines need 3:1 (1.4.11).
// Exits non-zero when a pair is below its threshold.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'packages/ui/src/styles/tokens.css'), 'utf8');

/** Custom properties declared directly in the first block opened by `selector`. */
function declarations(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  let depth = 0;
  let end = start;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const vars = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const light = declarations(':root');
const themes = { light, dark: { ...light, ...declarations("[data-theme='dark']") } };

function resolveVar(vars, value, seen = new Set()) {
  const m = /^var\((--[\w-]+)\)$/.exec(value);
  if (!m) return value;
  if (seen.has(m[1])) throw new Error(`cyclic ${m[1]}`);
  seen.add(m[1]);
  return resolveVar(vars, vars[m[1]], seen);
}

// --- color parsing to linear sRGB ----------------------------------------
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255));
  }
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+%?)?\)$/.exec(value);
  if (ok) {
    if (value.includes('/')) throw new Error(`translucent colors cannot be checked: ${value}`);
    const L = Number(ok[1]) / (ok[2] ? 100 : 1);
    const C = Number(ok[3]);
    const h = (Number(ok[4]) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ].map((c) => Math.min(1, Math.max(0, c)));
  }
  throw new Error(`unsupported color: ${value}`);
}

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum, what]
const TEXT = 4.5;
const UI = 3;
const PAIRS = [
  ['--foreground', '--background', TEXT, 'body text'],
  ['--foreground', '--card', TEXT, 'text on cards'],
  ['--foreground', '--popover', TEXT, 'text in popovers'],
  ['--muted-foreground', '--background', TEXT, 'secondary text'],
  ['--muted-foreground', '--muted', TEXT, 'secondary text on muted surfaces'],
  ['--muted-foreground', '--card', TEXT, 'secondary text on cards'],
  ['--muted-foreground', '--sidebar', TEXT, 'sidebar labels'],
  ['--secondary-foreground', '--secondary', TEXT, 'secondary buttons'],
  ['--accent-foreground', '--accent', TEXT, 'hovered items'],
  ['--accent-brand', '--background', TEXT, 'brand accent text and links'],
  ['--primary-foreground', '--primary', TEXT, 'primary button label'],
  ['--sidebar-foreground', '--sidebar', TEXT, 'sidebar text'],
  ['--sidebar-accent-foreground', '--sidebar-accent', TEXT, 'active sidebar item'],
  ['--destructive', '--background', TEXT, 'error text'],
  ['--mention-foreground', '--mention', TEXT, 'mention badge'],
  ['--ring', '--background', UI, 'focus ring'],
  ['--ring', '--card', UI, 'focus ring on cards'],
  ['--input', '--background', UI, 'form control outline'],
  ['--input', '--card', UI, 'form control outline on cards'],
  ['--primary', '--background', UI, 'primary button shape'],
];

let failures = 0;
for (const [theme, vars] of Object.entries(themes)) {
  console.log(`${theme} theme`);
  for (const [fg, bg, min, what] of PAIRS) {
    const ratio = contrast(
      parseColor(resolveVar(vars, vars[fg])),
      parseColor(resolveVar(vars, vars[bg])),
    );
    const ok = ratio >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2).padStart(5)}:1 (>= ${min})  ${fg} on ${bg}  ${what}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} contrast pair(s) below the WCAG threshold`);
  process.exit(1);
}
console.log('\nAll contrast pairs meet WCAG 2.2 AA.');
