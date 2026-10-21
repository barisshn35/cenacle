// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { clientOrigins, interpolate, loadClients } from '../src/oidc/clients.ts';

const SECRET = 's'.repeat(40);
const clientsJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      client_id: 'cenacle-chat',
      client_name: 'Cenacle',
      client_secret_file: 'secret.txt',
      redirect_uris: ['https://${CENACLE_DOMAIN}/api/auth/callback'],
      post_logout_redirect_uris: ['https://${CENACLE_DOMAIN}/'],
      first_party: true,
      ...over,
    },
  ]);

function files(json: string, secret = SECRET) {
  return (p: string) => (p.endsWith('secret.txt') ? `${secret}\n` : json);
}

describe('clients file', () => {
  it('interpolates environment variables and reads secrets from files', () => {
    const [c] = loadClients('/etc/cenacle/clients.json', files(clientsJson()), {
      CENACLE_DOMAIN: 'chat.example.com',
    });
    expect(c).toMatchObject({
      client_id: 'cenacle-chat',
      client_secret: SECRET,
      redirect_uris: ['https://chat.example.com/api/auth/callback'],
      cenacle_first_party: true,
      response_types: ['code'],
      grant_types: ['authorization_code'],
    });
    expect(clientOrigins([c!])).toEqual(['https://chat.example.com']);
  });

  it('fails on a missing variable instead of producing a broken URL', () => {
    expect(() => interpolate('https://${CENACLE_DOMAIN}/', {})).toThrow(/CENACLE_DOMAIN/);
  });

  it.each([
    ['plain http to a remote host', { redirect_uris: ['http://chat.example.com/cb'] }],
    ['a fragment', { redirect_uris: ['https://chat.example.com/cb#x'] }],
    ['unknown fields', { response_types: ['token'] }],
  ])('rejects %s', (_name, over) => {
    expect(() =>
      loadClients('/x/clients.json', files(clientsJson(over)), { CENACLE_DOMAIN: 'a.example' }),
    ).toThrow();
  });

  it('rejects short secrets', () => {
    expect(() =>
      loadClients('/x/clients.json', files(clientsJson(), 'short'), {
        CENACLE_DOMAIN: 'a.example',
      }),
    ).toThrow(/32\+ characters/);
  });

  it('allows http only for loopback redirect URIs', () => {
    const [c] = loadClients(
      '/x/clients.json',
      files(clientsJson({ redirect_uris: ['http://localhost:8180/api/auth/callback'] })),
      { CENACLE_DOMAIN: 'a.example' },
    );
    expect(c!.redirect_uris).toEqual(['http://localhost:8180/api/auth/callback']);
  });
});
