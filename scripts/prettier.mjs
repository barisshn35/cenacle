#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs Prettier on the files git would commit: tracked files plus untracked
// ones that no ignore rule (.gitignore, .git/info/exclude, the global excludes
// file) covers. Prettier's own --ignore-path resolves patterns relative to the
// ignore file's directory, so it cannot read .git/info/exclude, and local
// folders kept out of git there would otherwise be checked too.
//
//   node scripts/prettier.mjs --check
//   node scripts/prettier.mjs --write
//
// Outside a git checkout (a source archive) it falls back to the whole tree.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  console.error('usage: node scripts/prettier.mjs --check|--write');
  process.exit(2);
}

let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter((file) => file && existsSync(join(root, file)));
} catch {
  files = ['.'];
}

const prettier = join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
const base = [
  mode,
  '--ignore-unknown',
  '--ignore-path',
  '.gitignore',
  '--ignore-path',
  '.prettierignore',
];
// Batches keep the command line under the Windows limit (32 767 characters).
let status = 0;
for (let i = 0; i < files.length;) {
  const batch = [];
  let length = 0;
  while (i < files.length && length + files[i].length < 24_000) {
    length += files[i].length + 1;
    batch.push(files[i++]);
  }
  const run = spawnSync(process.execPath, [prettier, ...base, ...batch], {
    cwd: root,
    stdio: 'inherit',
  });
  if (run.status !== 0) status = run.status ?? 1;
}
process.exit(status);
