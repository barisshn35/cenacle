#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Renders the mobile app's icons and splash screens from the brand files
// (web/public/brand) and sets the app version from package.json. Run when the
// logo or the version changes (`pnpm assets`); the outputs are committed.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(root, '..', 'web', 'public', 'brand');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const ios = join(root, 'ios', 'App', 'App', 'Assets.xcassets');

// The mark: arch and bubble on the 48-unit grid, in the dark app icon's inks.
const darkIcon = readFileSync(join(brand, 'cenacle-icon-dark.svg'), 'utf8');
const mark = darkIcon.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const GROUND = '#121212';

const png = (svg, width) =>
  Buffer.from(
    new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } })
      .render()
      .asPng(),
  );

/** The mark centred on a w×h ground, as large as `share` of the shorter side. */
function tile(w, h, share, ground = GROUND, radius = 0) {
  const size = Math.min(w, h) * share;
  const x = (w - size) / 2;
  const y = (h - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${
    ground ? `<rect width="${w}" height="${h}" rx="${radius}" fill="${ground}"/>` : ''
  }<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 48 48">${mark}</svg></svg>`;
}

/** Width and height of a PNG (its IHDR chunk). */
function sizeOf(file) {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

// Android launcher icons: legacy square and round icons per density, and the
// adaptive icon's foreground (108 dp, the mark inside the 66 dp safe zone).
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, scale] of Object.entries(DENSITIES)) {
  const dir = join(res, `mipmap-${name}`);
  const legacy = Math.round(48 * scale);
  writeFileSync(
    join(dir, 'ic_launcher.png'),
    png(tile(legacy, legacy, 0.62, GROUND, legacy * 0.22), legacy),
  );
  writeFileSync(
    join(dir, 'ic_launcher_round.png'),
    png(tile(legacy, legacy, 0.62, GROUND, legacy / 2), legacy),
  );
  const fg = Math.round(108 * scale);
  writeFileSync(join(dir, 'ic_launcher_foreground.png'), png(tile(fg, fg, 0.56, null), fg));
}
writeFileSync(
  join(res, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${GROUND}</color>\n</resources>\n`,
);

// Android splash screens: every splash.png the template has, at its own size.
for (const dir of readdirSync(res).filter((d) => d.startsWith('drawable'))) {
  const file = join(res, dir, 'splash.png');
  try {
    const [w, h] = sizeOf(file);
    writeFileSync(file, png(tile(w, h, 0.22), w));
  } catch {
    // This density has no splash screen.
  }
}

// iOS: the 1024 px app icon (no transparency, the system rounds it) and the splash.
writeFileSync(
  join(ios, 'AppIcon.appiconset', 'AppIcon-512@2x.png'),
  png(tile(1024, 1024, 0.5), 1024),
);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'])
  writeFileSync(join(ios, 'Splash.imageset', name), png(tile(2732, 2732, 0.16), 2732));

// The version: 0.37.1 → versionName 0.37.1, versionCode 37001 (major·10⁶ + minor·10³ + patch).
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const [major, minor, patch] = version.split(/[.-]/).map(Number);
const code = major * 1_000_000 + minor * 1_000 + patch;
const gradle = join(root, 'android', 'app', 'build.gradle');
writeFileSync(
  gradle,
  readFileSync(gradle, 'utf8')
    .replace(/versionCode \d+/, `versionCode ${code}`)
    .replace(/versionName "[^"]*"/, `versionName "${version}"`),
);
const pbx = join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
writeFileSync(
  pbx,
  readFileSync(pbx, 'utf8')
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${code};`),
);
console.log(`icons, splash screens and version ${version} (${code}) written`);
