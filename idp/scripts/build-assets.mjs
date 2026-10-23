#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds public/assets for the Cenacle ID pages: compiled CSS (Tailwind with
// the shared Cenacle tokens), the bundled fonts, the WebAuthn browser library
// and static files.

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'assets');
const require = createRequire(join(root, 'package.json'));

rmSync(join(root, 'public'), { recursive: true, force: true });
mkdirSync(join(out, 'fonts'), { recursive: true });

for (const pkg of ['geist', 'geist-mono']) {
  const dir = dirname(require.resolve(`@fontsource-variable/${pkg}/package.json`));
  for (const file of [`${pkg}-latin-wght-normal.woff2`, `${pkg}-latin-ext-wght-normal.woff2`]) {
    copyFileSync(join(dir, 'files', file), join(out, 'fonts', file));
  }
}
cpSync(join(root, 'assets'), out, { recursive: true });
// The browser half of SimpleWebAuthn (MIT), served by us (no CDN).
// The package exports only its entry point (script/index.js): its root is one up.
const webauthn = dirname(dirname(require.resolve('@simplewebauthn/browser')));
copyFileSync(join(webauthn, 'dist', 'bundle', 'index.umd.min.js'), join(out, 'simplewebauthn.js'));

execFileSync(
  join(root, 'node_modules', '.bin', 'tailwindcss'),
  ['--input', join(root, 'src/ui/styles.css'), '--output', join(out, 'cenacle-id.css'), '--minify'],
  { stdio: 'inherit', cwd: root },
);
