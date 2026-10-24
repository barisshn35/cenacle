#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Renders the app icons from the logo (run when the logo changes; the PNGs
// are committed): the window and installer icons, the tray icon and the dot
// that marks unread messages on the Windows taskbar.
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arch = (ink) =>
  `<path fill="none" stroke="${ink}" stroke-width="6.5" stroke-linecap="round" d="M10 41V22A14 14 0 0 1 38 22V41"/><path fill="#C9A24B" d="M17.5 33V25.5A5.5 5.5 0 0 1 23 20H25A5.5 5.5 0 0 1 30.5 25.5V27.5A5.5 5.5 0 0 1 25 33Z"/>`;
// The app icon is the brand's dark app icon (web/public/brand).
const icon = readFileSync(
  join(root, '..', 'web', 'public', 'brand', 'cenacle-appicon-dark.svg'),
  'utf8',
);
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${arch('#F2F2F2')}</svg>`;
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#B42318" stroke="#FFFFFF" stroke-width="1.5"/></svg>`;

const render = (svg, size, path) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
};
render(icon, 512, join(root, 'assets', 'icon.png'));
render(icon, 1024, join(root, 'build', 'icon.png'));
for (const size of [16, 32, 48, 64, 128, 256, 512])
  render(icon, size, join(root, 'build', 'icons', `${size}x${size}.png`));
render(tray, 32, join(root, 'assets', 'tray.png'));
render(badge, 16, join(root, 'assets', 'badge.png'));
