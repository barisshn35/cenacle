#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Writes the third-party notices of what a Cenacle build ships: each package's
// name, version and license, followed by its license and NOTICE files (MIT,
// BSD and Apache-2.0 ask for them in every copy that is passed on). Identical
// texts are printed once, under every package that uses them.
//
//   node scripts/third-party-notices.mjs pnpm <workspace package> [extra package…] > NOTICES.txt
//     the production dependencies of a workspace package, plus packages it
//     bundles from its development dependencies (fonts, browser libraries)
//
// The web app builds its notices from what the bundle contains
// (web/vite.config.ts uses noticesFor); Go programs use scripts/go-notices.sh.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([.-][\w.-]*)?$/i;

/** The license and notice files of a package directory, by name. */
function licenseTexts(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => LICENSE_FILE.test(n));
  } catch {
    return [];
  }
  return names.sort().map((n) => readFileSync(join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim());
}

/** The package directory that holds a file: the nearest package.json with a name. */
export function packageDirOf(file) {
  let dir = dirname(file);
  while (dir.includes('node_modules')) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).name) return dir;
      } catch {
        // A broken package.json: keep looking up.
      }
    }
    dir = dirname(dir);
  }
  return null;
}

/** The notices of the packages in these directories, as one text. */
export function noticesFor(dirs, title) {
  const packages = new Map();
  for (const d of dirs) {
    const dir = realpathSync(d);
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pj.name || pj.name.startsWith('@cenacle/')) continue;
    const license =
      typeof pj.license === 'string' ? pj.license : (pj.license?.type ?? 'see the package');
    const author = typeof pj.author === 'string' ? pj.author : pj.author?.name;
    packages.set(`${pj.name}@${pj.version}`, {
      id: `${pj.name}@${pj.version}`,
      license,
      author,
      dir,
    });
  }
  // Group the packages by the exact text of their license files.
  const groups = new Map();
  const sorted = [...packages.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const p of sorted) {
    const texts = licenseTexts(p.dir);
    const text = texts.length
      ? texts.join('\n\n')
      : `The package ships no license file; its declared license is ${p.license}` +
        (p.author ? `, by ${p.author}.` : '.');
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(`${p.id} (${p.license})`);
  }
  const rule = '='.repeat(78);
  const parts = [
    `${title}\n\nThis software includes the following third-party packages (${packages.size}).\n` +
      'Their licenses and notices follow; each text applies to the packages listed above it.',
  ];
  for (const [text, ids] of groups) parts.push(`${rule}\n${ids.join('\n')}\n${rule}\n\n${text}`);
  return `${parts.join('\n\n')}\n`;
}

function fromPnpm(workspacePackage, extra) {
  const out = execFileSync(
    'pnpm',
    ['--filter', workspacePackage, 'licenses', 'list', '--json', '--prod'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const dirs = Object.values(JSON.parse(out || '{}'))
    .flat()
    .flatMap((p) => p.paths);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkgDir = execFileSync(
    'pnpm',
    ['--filter', workspacePackage, 'exec', 'node', '-p', 'process.cwd()'],
    { encoding: 'utf8', cwd: root },
  ).trim();
  const require = createRequire(join(pkgDir, 'package.json'));
  for (const name of extra) {
    const linked = join(pkgDir, 'node_modules', name);
    dirs.push(existsSync(linked) ? linked : packageDirOf(require.resolve(name)));
  }
  return noticesFor(dirs, `Third-party notices of ${workspacePackage}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, pkg, ...extra] = process.argv.slice(2);
  if (mode !== 'pnpm' || !pkg) {
    console.error('usage: third-party-notices.mjs pnpm <workspace package> [extra package…]');
    process.exit(2);
  }
  process.stdout.write(fromPnpm(pkg, extra));
}
