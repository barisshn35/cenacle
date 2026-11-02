// SPDX-License-Identifier: AGPL-3.0-only
// Signs the app's update files (release/latest*.yml) with the release key
// (Ed25519, DESKTOP_UPDATE_KEY: the PEM private key file) as <name>.sig.
// The app installs an update only when one of the keys built into it
// (src/update-keys.ts) signed its update file. Run from desktop/ after
// `pnpm build` and electron-builder (docs/operations/ci.md).
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPDATE_KEYS } from '../dist/update-keys.js';
import { signedMessage, verifyUpdateFile } from '../dist/update-signature.js';

const keyFile = process.env.DESKTOP_UPDATE_KEY;
if (!keyFile) {
  console.log(
    'DESKTOP_UPDATE_KEY is not set: the update files are not signed, and apps will not install this release as an update',
  );
  process.exit(0);
}
const key = createPrivateKey(readFileSync(keyFile));
const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString().trim();
if (!UPDATE_KEYS.some((k) => k.trim() === pub)) {
  console.error(
    'DESKTOP_UPDATE_KEY is not one of the keys built into the app (src/update-keys.ts)',
  );
  process.exit(1);
}
const dir = 'release';
const files = readdirSync(dir).filter((f) => /^latest.*\.yml$/.test(f));
if (files.length === 0) {
  console.error('no update files in release/');
  process.exit(1);
}
for (const name of files) {
  const data = readFileSync(join(dir, name));
  const sig = sign(null, signedMessage(name, data), key).toString('base64');
  if (!verifyUpdateFile(name, data, sig)) {
    console.error(`${name}: the signature does not verify`);
    process.exit(1);
  }
  writeFileSync(join(dir, `${name}.sig`), `${sig}\n`);
  console.log(`signed ${name}`);
}
