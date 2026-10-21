#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Renders the raster brand assets of the web app from the committed SVGs
// (web/public/brand). Run with `make brand`; the outputs are committed.
//
//   apple-touch-icon.png  180x180  app icon (dark)
//   icon-192.png          192x192  app icon (dark), web manifest
//   icon-512.png          512x512  app icon (dark), web manifest
//   favicon.ico           32x32    favicon (light), PNG inside an ICO container

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'web', 'public');
const brand = join(pub, 'brand');

function render(svgFile, size) {
  const svg = readFileSync(join(brand, svgFile), 'utf8');
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false }, // the SVGs contain outlines only
  })
    .render()
    .asPng();
  return Buffer.from(png);
}

/** ICO container with one embedded PNG image (supported since Windows Vista). */
function ico(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // no palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image size
  entry.writeUInt32LE(header.length + entry.length, 12); // image offset
  return Buffer.concat([header, entry, png]);
}

const outputs = [
  ['apple-touch-icon.png', render('cenacle-appicon-dark.svg', 180)],
  ['icon-192.png', render('cenacle-appicon-dark.svg', 192)],
  ['icon-512.png', render('cenacle-appicon-dark.svg', 512)],
  ['favicon.ico', ico(render('favicon-32-light.svg', 32), 32)],
];
for (const [name, data] of outputs) {
  writeFileSync(join(pub, name), data);
  console.log(`web/public/${name} (${data.length} bytes)`);
}
