// SPDX-License-Identifier: AGPL-3.0-only
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const release = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

vi.mock('./update-keys.js', () => ({
  UPDATE_KEYS: [release.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
}));

const { SignedProvider } = await import('./update-provider.js');
const { signedMessage, verifyUpdateFile } = await import('./update-signature.js');
const { UPDATE_KEYS: BUILT_IN } =
  await vi.importActual<typeof import('./update-keys.js')>('./update-keys.js');

const yml = `version: 99.0.0
files:
  - url: Cenacle-99.0.0-setup.exe
    sha512: AAAA
    size: 1
path: Cenacle-99.0.0-setup.exe
sha512: AAAA
releaseDate: '2026-11-02T00:00:00.000Z'
`;

const sigOf = (key: typeof release, name: string, data: string) =>
  sign(null, signedMessage(name, Buffer.from(data, 'utf8')), key.privateKey).toString('base64');

/** A paired server serving the files by path (404 when missing). */
function provider(files: Record<string, string>) {
  const request = vi.fn(async (opts: { path?: string }) => {
    const path = (opts.path ?? '').split('?')[0]!;
    if (!(path in files)) throw Object.assign(new Error('404'), { statusCode: 404 });
    return files[path]!;
  });
  const updater = { channel: null, isAddNoCacheQuery: false } as never;
  const p = new SignedProvider({ url: 'https://chat.example/downloads/desktop' }, updater, {
    executor: { request } as never,
    platform: 'win32',
    isUseMultipleRangeRequest: false,
  });
  return { p, request };
}

describe('update signatures', () => {
  it('takes an update file signed with the release key', async () => {
    const { p } = provider({
      '/downloads/desktop/latest.yml': yml,
      '/downloads/desktop/latest.yml.sig': sigOf(release, 'latest.yml', yml),
    });
    const info = await p.getLatestVersion();
    expect(info.version).toBe('99.0.0');
  });

  it.each([
    ['no signature', {}],
    ['another key', { '/downloads/desktop/latest.yml.sig': sigOf(other, 'latest.yml', yml) }],
    [
      'another file',
      { '/downloads/desktop/latest.yml.sig': sigOf(release, 'latest-linux.yml', yml) },
    ],
    [
      'changed content',
      {
        '/downloads/desktop/latest.yml.sig': sigOf(
          release,
          'latest.yml',
          yml.replace('AAAA', 'BBBB'),
        ),
      },
    ],
    ['garbage', { '/downloads/desktop/latest.yml.sig': 'not a signature' }],
  ])('refuses an update file with %s', async (_, sig) => {
    const { p } = provider({ '/downloads/desktop/latest.yml': yml, ...sig });
    await expect(p.getLatestVersion()).rejects.toThrow();
  });

  it('builds in a valid Ed25519 release key', () => {
    expect(BUILT_IN.length).toBeGreaterThan(0);
    for (const pem of BUILT_IN) expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519');
    const data = Buffer.from(yml);
    expect(verifyUpdateFile('latest.yml', data, sigOf(other, 'latest.yml', yml), BUILT_IN)).toBe(
      false,
    );
  });
});
