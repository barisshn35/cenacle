#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copies the app's own pages and the bundled fonts next to the compiled code.
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

cpSync(join(root, 'src', 'pages'), join(root, 'dist', 'pages'), { recursive: true });

// Geist and Geist Mono (SIL OFL-1.1), served from the app's own files.
const fonts = join(root, 'assets', 'fonts');
mkdirSync(fonts, { recursive: true });
for (const pkg of ['geist', 'geist-mono']) {
  const dir = dirname(require.resolve(`@fontsource-variable/${pkg}/package.json`));
  for (const file of [`${pkg}-latin-wght-normal.woff2`, `${pkg}-latin-ext-wght-normal.woff2`]) {
    copyFileSync(join(dir, 'files', file), join(fonts, file));
  }
}
