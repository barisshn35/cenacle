// SPDX-License-Identifier: AGPL-3.0-only
//
// Starts Cenacle ID in-process against the integration test database, with a
// registered first-party client whose redirect URI points at a local callback
// server, so tests can drive the whole authorization code flow.

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { AuditLog } from '../src/accounts/audit.ts';
import { MfaStore } from '../src/accounts/mfa.ts';
import { PasskeyStore } from '../src/accounts/passkeys.ts';
import { UserStore } from '../src/accounts/users.ts';
import { buildApp } from '../src/app.ts';
import { SourceStore } from '../src/directory/store.ts';
import { ProviderStore } from '../src/federation/store.ts';
import { migrate } from '../src/db/migrate.ts';
import { KeyStore } from '../src/keys/store.ts';
import type { ClientMetadata } from '../src/oidc/clients.ts';
import { createProvider } from '../src/oidc/provider.ts';

export const DATABASE_URL = process.env.IDP_TEST_DATABASE_URL;
export const CLIENT_ID = 'cenacle-test';
export const CLIENT_SECRET = randomBytes(32).toString('base64url');
export const PASSWORD = 'correct horse battery staple';
export const EMAIL = 'ayse@example.com';

const ASSETS_DIR = fileURLToPath(new URL('../public/assets', import.meta.url));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface Harness {
  issuer: string;
  callbackUrl: string;
  postLogoutUrl: string;
  pool: pg.Pool;
  keys: KeyStore;
  /** Identity providers people may sign in with (with the directory option). */
  providers: ProviderStore;
  /** Query strings received by the client callback, newest last. */
  callbacks: URLSearchParams[];
  /** Logout tokens the client received over the back channel. */
  logoutTokens: string[];
  /** Restarts the IdP (e.g. after a key rotation). */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(
  opts: {
    loginRateLimit?: number;
    directory?: boolean;
    scope?: string;
    /** Host of the issuer: passkeys need a domain name (localhost), not an IP address. */
    host?: string;
  } = {},
): Promise<Harness> {
  if (!DATABASE_URL) throw new Error('IDP_TEST_DATABASE_URL is not set');
  await migrate({ databaseUrl: DATABASE_URL, direction: 'up' });
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await pool.query(
    'TRUNCATE users, oidc_payloads, signing_keys, audit_events, identity_sources, webauthn_challenges CASCADE',
  );

  const users = new UserStore(pool);
  await users.create({
    email: EMAIL,
    displayName: 'Ayşe Yılmaz',
    password: PASSWORD,
    emailVerified: true,
  });
  // The test account administers Cenacle ID (the admin panel).
  await users.setAdmin(EMAIL, true);
  const kek = randomBytes(32);
  const sources = new SourceStore(pool, kek);
  const providers = new ProviderStore(pool, kek);
  const keys = new KeyStore(pool, kek);
  await keys.ensureActiveKey();

  const callbacks: URLSearchParams[] = [];
  const logoutTokens: string[] = [];
  const rp: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/backchannel') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        logoutTokens.push(new URLSearchParams(body).get('logout_token') ?? '');
        res.writeHead(200).end();
      });
      return;
    }
    callbacks.push(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('client callback');
  });
  await new Promise<void>((r) => rp.listen(0, '127.0.0.1', r));
  const rpOrigin = `http://127.0.0.1:${(rp.address() as AddressInfo).port}`;
  const callbackUrl = `${rpOrigin}/cb`;
  const postLogoutUrl = `${rpOrigin}/signed-out`;

  const port = await freePort();
  const host = opts.host ?? '127.0.0.1';
  const issuer = `http://${host}:${port}`;
  const client: ClientMetadata = {
    client_id: CLIENT_ID,
    client_name: 'Cenacle Test',
    client_secret: CLIENT_SECRET,
    redirect_uris: [callbackUrl],
    post_logout_redirect_uris: [postLogoutUrl],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    scope: opts.scope ?? 'openid email profile',
    cenacle_first_party: true,
    backchannel_logout_uri: `${rpOrigin}/backchannel`,
    backchannel_logout_session_required: true,
  };

  let app: FastifyInstance | undefined;
  const start = async () => {
    const provider = createProvider({
      issuer,
      pool,
      users,
      clients: [client],
      signingKeys: await keys.loadSigningKeys(3600),
      cookieKeys: ['e2e-cookie-key-0123456789abcdefghij'],
      cookieDomain: '',
      trustProxy: false,
      formActionOrigins: [rpOrigin],
    });
    app = await buildApp({
      assetsDir: ASSETS_DIR,
      oidc: {
        provider,
        users,
        issuer,
        formActionOrigins: [rpOrigin],
        loginRateLimit: opts.loginRateLimit,
        mfa: new MfaStore(pool, kek),
        audit: new AuditLog(pool),
        cookieKeys: ['e2e-cookie-key-0123456789abcdefghij'],
        directory: opts.directory ? { pool, sources } : undefined,
        passkeys: new PasskeyStore(pool, issuer),
        federation: opts.directory ? providers : undefined,
      },
    });
    await app.listen({ host, port });
  };
  await start();

  return {
    issuer,
    callbackUrl,
    postLogoutUrl,
    pool,
    keys,
    providers,
    callbacks,
    logoutTokens,
    async restart() {
      await app?.close();
      await start();
    },
    async close() {
      await app?.close();
      await new Promise<void>((r) => rp.close(() => r()));
      await pool.end();
    },
  };
}
