#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Builds public/assets for the Cenacle ID pages: compiled CSS (Tailwind with
// the shared Cenacle tokens), the bundled Geist fonts and static files.

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

const geist = dirname(require.resolve('@fontsource-variable/geist/package.json'));
for (const file of ['geist-latin-wght-normal.woff2', 'geist-latin-ext-wght-normal.woff2']) {
  copyFileSync(join(geist, 'files', file), join(out, 'fonts', file));
}
cpSync(join(root, 'assets'), out, { recursive: true });

execFileSync(
  join(root, 'node_modules', '.bin', 'tailwindcss'),
  ['--input', join(root, 'src/ui/styles.css'), '--output', join(out, 'cenacle-id.css'), '--minify'],
  { stdio: 'inherit', cwd: root },
);
