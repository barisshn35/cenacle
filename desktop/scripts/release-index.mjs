#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Writes release/index.json: the installers of this build, which the web
// app lists for download (its "Use the Cenacle app" page). Copy it with the
// installers and the update files into the server's downloads/desktop/.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const kinds = [
  [/\.exe$/, 'windows', 'installer'],
  [/\.msi$/, 'windows', 'msi'],
  [/\.AppImage$/, 'linux', 'appimage'],
  [/\.deb$/, 'linux', 'deb'],
  [/\.rpm$/, 'linux', 'rpm'],
];
// The Windows installer carries both architectures.
const archOf = (file) =>
  file.endsWith('.exe') ? 'x64, arm64' : /(arm64|aarch64)/.test(file) ? 'arm64' : 'x64';

const files = readdirSync(release)
  .filter((file) => file.includes(`-${version}-`))
  .flatMap((file) => {
    const kind = kinds.find(([re]) => re.test(file));
    if (!kind) return [];
    return [
      {
        file,
        platform: kind[1],
        arch: archOf(file),
        kind: kind[2],
        size: statSync(join(release, file)).size,
      },
    ];
  })
  .sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.kind.localeCompare(b.kind) ||
      a.arch.localeCompare(b.arch),
  );

writeFileSync(join(release, 'index.json'), `${JSON.stringify({ version, files }, null, 2)}\n`);
console.log(`release/index.json: ${files.length} installers of ${version}`);
