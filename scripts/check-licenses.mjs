#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Enforces the dependency license policy for the JS workspace
// (see docs/adr/0001-monorepo-and-tooling.md).
//
// - Production dependencies must use a license from PROD_ALLOWED.
// - Development-only dependencies may additionally use DEV_EXTRA (permissive
//   data/tooling licenses that never ship in the product).
// - Fonts (OFL-1.1) are allowed for the explicit packages in FONT_PACKAGES only.
// - Any other license, or a missing/unknown license, fails the check.

import { execFileSync } from 'node:child_process';

const PROD_ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  '0BSD',
  'Unlicense',
  // Blue Oak Model License: OSI-approved permissive license (used by glob, minimatch, ...).
  'BlueOak-1.0.0',
]);

const DEV_EXTRA = new Set(['CC-BY-4.0', 'CC0-1.0', 'Python-2.0']);

const FONT_PACKAGES = new Set([
  '@fontsource-variable/geist',
  '@fontsource-variable/geist-mono',
  '@fontsource-variable/fraunces',
  '@fontsource-variable/inter',
  '@fontsource-variable/jetbrains-mono',
  // The font library (ADR 0013, v0.16).
  '@fontsource-variable/ibm-plex-sans',
  '@fontsource-variable/manrope',
  '@fontsource-variable/source-sans-3',
  '@fontsource-variable/figtree',
  '@fontsource-variable/public-sans',
  '@fontsource-variable/plus-jakarta-sans',
  '@fontsource-variable/noto-sans',
  '@fontsource-variable/atkinson-hyperlegible-next',
  '@fontsource/ibm-plex-mono',
  '@fontsource-variable/fira-code',
  '@fontsource-variable/source-code-pro',
  '@fontsource-variable/cascadia-code',
  '@fontsource-variable/roboto-mono',
  '@fontsource-variable/red-hat-mono',
  '@fontsource-variable/noto-sans-mono',
  '@fontsource/commit-mono',
]);

function listLicenses(prodOnly) {
  const args = ['licenses', 'list', '--json', '--recursive'];
  if (prodOnly) args.push('--prod');
  const out = execFileSync('pnpm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out || '{}');
}

// Accepts simple SPDX expressions: "A OR B" passes if any part passes,
// "A AND B" passes only if all parts pass.
function expressionAllowed(expr, allowed) {
  const clean = expr.replace(/[()]/g, '').trim();
  if (clean.includes(' OR ')) return clean.split(' OR ').some((p) => allowed(p.trim()));
  if (clean.includes(' AND ')) return clean.split(' AND ').every((p) => allowed(p.trim()));
  return allowed(clean);
}

const violations = [];
const prodNames = new Set();

for (const [license, pkgs] of Object.entries(listLicenses(true))) {
  for (const pkg of pkgs) {
    prodNames.add(pkg.name);
    const ok = expressionAllowed(
      license,
      (l) => PROD_ALLOWED.has(l) || (l === 'OFL-1.1' && FONT_PACKAGES.has(pkg.name)),
    );
    if (!ok) violations.push({ scope: 'prod', name: pkg.name, versions: pkg.versions, license });
  }
}

let devCount = 0;
for (const [license, pkgs] of Object.entries(listLicenses(false))) {
  for (const pkg of pkgs) {
    if (prodNames.has(pkg.name)) continue;
    devCount++;
    const ok = expressionAllowed(license, (l) => PROD_ALLOWED.has(l) || DEV_EXTRA.has(l));
    if (!ok) violations.push({ scope: 'dev', name: pkg.name, versions: pkg.versions, license });
  }
}

if (violations.length > 0) {
  console.error('License policy violations:');
  for (const v of violations) {
    console.error(`  [${v.scope}] ${v.name}@${v.versions.join(',')}: ${v.license}`);
  }
  process.exit(1);
}

console.log(
  `License check passed: ${prodNames.size} production and ${devCount} development packages.`,
);
