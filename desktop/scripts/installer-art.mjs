#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Renders the Windows installer's pictures from the logo (run when the logo
// changes; the BMPs are committed): the side picture of the welcome and finish
// pages (164×314), the header of the other pages (150×57) and the splash
// that fades in and out as the installer starts (360×220), as 24-bit BMPs,
// which is what NSIS takes. No words but the wordmark, so both languages share
// them. The arch behind the icon is the "upper room" of the brand.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = (name) => readFileSync(join(root, '..', 'web', 'public', 'brand', name), 'utf8');
// An SVG file's drawing and viewBox, to place it inside another one.
const part = (svg) => ({
  inner: svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, ''),
  viewBox: /viewBox="([^"]+)"/.exec(svg)[1],
});
const icon = part(brand('cenacle-appicon-dark.svg'));
const wordmarkOnDark = part(brand('cenacle-wordmark-dark.svg').replace(/#F2F2F2/g, '#F3EEE2'));
const lockupOnLight = part(brand('cenacle-lockup-light.svg'));
const place = (p, x, y, w, h) =>
  `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${p.viewBox}">${p.inner}</svg>`;

const sidebar = `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="installer-ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0C1A16"/>
      <stop offset="1" stop-color="#14342B"/>
    </linearGradient>
  </defs>
  <rect width="164" height="314" fill="url(#installer-ground)"/>
  <path d="M14 314V128A68 68 0 0 1 150 128V314" fill="none" stroke="#C9A24B" stroke-opacity="0.22" stroke-width="1.5"/>
  <path d="M30 314V134A52 52 0 0 1 134 134V314" fill="none" stroke="#F3EEE2" stroke-opacity="0.07" stroke-width="1"/>
  ${place(icon, 50, 108, 64, 64)}
  ${place(wordmarkOnDark, 32, 192, 100, 25)}
  <rect x="70" y="232" width="24" height="1.5" rx="0.75" fill="#C9A24B"/>
</svg>`;

const header = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#FFFFFF"/>
  ${place(lockupOnLight, 14, 17, 122, 23)}
</svg>`;

const splash = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">
  <defs>
    <linearGradient id="installer-splash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0C1A16"/>
      <stop offset="1" stop-color="#14342B"/>
    </linearGradient>
  </defs>
  <rect width="360" height="220" fill="url(#installer-splash)"/>
  <path d="M112 220V112A68 68 0 0 1 248 112V220" fill="none" stroke="#C9A24B" stroke-opacity="0.22" stroke-width="1.5"/>
  ${place(icon, 148, 54, 64, 64)}
  ${place(wordmarkOnDark, 130, 136, 100, 25)}
  <rect x="168" y="176" width="24" height="1.5" rx="0.75" fill="#C9A24B"/>
</svg>`;

// A 24-bit bottom-up BMP from opaque RGBA pixels.
function bmp(rgba, width, height) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + stride * height;
  const out = Buffer.alloc(size);
  out.write('BM', 0);
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[row + x * 3] = rgba[i + 2];
      out[row + x * 3 + 1] = rgba[i + 1];
      out[row + x * 3 + 2] = rgba[i];
    }
  }
  return out;
}

const write = (svg, names, preview) => {
  const image = new Resvg(svg).render();
  const file = bmp(image.pixels, image.width, image.height);
  for (const name of names) writeFileSync(join(root, 'build', name), file);
  if (preview) writeFileSync(preview, image.asPng());
};
const previews = process.argv[2];
write(
  sidebar,
  ['installerSidebar.bmp', 'uninstallerSidebar.bmp'],
  previews && join(previews, 'sidebar.png'),
);
write(header, ['installerHeader.bmp'], previews && join(previews, 'header.png'));
write(splash, ['installerSplash.bmp'], previews && join(previews, 'splash.png'));
