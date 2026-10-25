#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Packs the Windows x64 build (release/win-unpacked) as the MSI for
// organizations with wixl and wixl-heat (msitools): installed for all users,
// and marked so that the app leaves updates to the organization
// (resources/managed-install; docs/desktop/enterprise-deployment.md).
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const build = join(release, 'win-unpacked');
if (!existsSync(build)) {
  console.error('No Windows x64 build in release/: run electron-builder --win first.');
  process.exit(1);
}

const stage = join(release, 'msi-x64');
const files = join(stage, 'files');
rmSync(stage, { recursive: true, force: true });
cpSync(build, files, { recursive: true });
copyFileSync(join(root, 'build', 'managed-install'), join(files, 'resources', 'managed-install'));

// wixl takes paths relative to where it runs: everything is in the stage.
copyFileSync(join(root, 'build', 'msi', 'cenacle.wxs'), join(stage, 'cenacle.wxs'));
copyFileSync(join(root, 'build', 'msi', 'cenacle.ico'), join(stage, 'cenacle.ico'));
const list = execFileSync('find', ['files', '-type', 'f'], { cwd: stage, encoding: 'utf8' });
const harvested = execFileSync(
  'wixl-heat',
  [
    '-p',
    'files/',
    '--directory-ref',
    'INSTALLDIR',
    '--component-group',
    'AppFiles',
    '--var',
    'var.SourceDir',
    '--win64',
  ],
  { cwd: stage, input: list, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
writeFileSync(join(stage, 'files.wxs'), harvested);

const out = join(release, `Cenacle-${version}-x64.msi`);
execFileSync(
  'wixl',
  [
    '-a',
    'x64',
    '-D',
    'Win64=yes',
    '-D',
    `Version=${version.split('-')[0]}`,
    '-D',
    'SourceDir=files',
    '-D',
    'Icon=cenacle.ico',
    '-o',
    out,
    'cenacle.wxs',
    'files.wxs',
  ],
  { cwd: stage, stdio: 'inherit' },
);
rmSync(stage, { recursive: true, force: true });
console.log(out);
