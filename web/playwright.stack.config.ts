// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end tests of the whole sign-in: Cenacle ID, the chat server and the
// web app run as real processes against the integration test databases
// (IDP_TEST_DATABASE_URL, CENACLE_TEST_DATABASE_URL) and Valkey
// (CENACLE_VALKEY_ADDR). Ports differ from the development servers, so both
// can run at the same time. Run with `make test-e2e-stack`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 5273;
const SERVER_PORT = 8280;
const IDP_PORT = 8290;

export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const IDP_URL = `http://localhost:${IDP_PORT}`;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

// The chat server's client registration at Cenacle ID, for this test run only.
const dir = join(tmpdir(), 'cenacle-e2e-stack');
mkdirSync(dir, { recursive: true });
const secretFile = join(dir, 'chat-client-secret.txt');
const clientsFile = join(dir, 'clients.json');
writeFileSync(secretFile, 'e2e-stack-only-chat-client-secret-0123456789\n');
writeFileSync(
  clientsFile,
  JSON.stringify([
    {
      client_id: 'cenacle-chat',
      client_name: 'Cenacle',
      client_secret_file: secretFile,
      redirect_uris: [`${WEB_URL}/api/auth/callback`],
      post_logout_redirect_uris: [`${WEB_URL}/`],
      backchannel_logout_uri: `http://127.0.0.1:${SERVER_PORT}/api/auth/backchannel-logout`,
      first_party: true,
      scope: 'openid email profile groups',
      directory_feed: true,
    },
  ]),
);

export const idpEnv = {
  IDP_ENV: 'development',
  IDP_HOST: '127.0.0.1',
  IDP_PORT: String(IDP_PORT),
  IDP_ISSUER: IDP_URL,
  IDP_LOG_LEVEL: 'warn',
  IDP_DATABASE_URL: required('IDP_TEST_DATABASE_URL'),
  IDP_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  IDP_COOKIE_KEYS: 'e2e-stack-only-cookie-key-0123456789',
  IDP_CLIENTS_FILE: clientsFile,
  // Every test signs in, some twice: more than the default 10 per minute.
  IDP_LOGIN_RATE_LIMIT: '1000',
};

/**
 * STACK_FIPS_IDP_IMAGE=<image> runs Cenacle ID from a FIPS image (and the chat
 * server in FIPS 140-3 mode): the same tests, with validated cryptography.
 */
const fipsImage = process.env.STACK_FIPS_IDP_IMAGE;
const idpCommand = fipsImage
  ? `docker run --rm --name cenacle-stack-idp --network host -v ${dir}:${dir}:ro ${Object.keys(
      idpEnv,
    )
      .map((k) => `-e ${k}`)
      .join(' ')} ${fipsImage}`
  : 'pnpm exec tsx src/server.ts';

const serverBin = join(dir, 'cenacle-server');
const serverEnv = {
  CENACLE_ENV: 'development',
  CENACLE_HTTP_ADDR: `127.0.0.1:${SERVER_PORT}`,
  CENACLE_LOG_LEVEL: 'warn',
  CENACLE_DATABASE_URL: required('CENACLE_TEST_DATABASE_URL'),
  CENACLE_VALKEY_ADDR: process.env.CENACLE_VALKEY_ADDR ?? '127.0.0.1:16379',
  CENACLE_PUBLIC_URL: WEB_URL,
  CENACLE_OIDC_ISSUER: IDP_URL,
  CENACLE_OIDC_CLIENT_ID: 'cenacle-chat',
  CENACLE_OIDC_CLIENT_SECRET_FILE: secretFile,
  CENACLE_ADMIN_EMAIL: 'deniz@example.com',
  CENACLE_ANNOUNCEMENT_CHANNEL: 'Central',
  CENACLE_DEFAULT_CHANNELS: 'General',
  // Files go to the development (or CI) Garage.
  CENACLE_S3_ENDPOINT: process.env.CENACLE_S3_ENDPOINT ?? 'http://127.0.0.1:13900',
  CENACLE_S3_ACCESS_KEY: required('CENACLE_S3_ACCESS_KEY'),
  CENACLE_S3_SECRET_KEY: required('CENACLE_S3_SECRET_KEY'),
  ...(fipsImage ? { GODEBUG: 'fips140=on' } : {}),
};

export default defineConfig({
  testDir: './e2e-stack',
  // One IdP and one database for all tests.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: WEB_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'cenacle-id',
      command:
        'node scripts/build-assets.mjs && pnpm exec tsx src/cli.ts migrate up && node ../web/e2e-stack/reset-idp-db.mjs && ' +
        idpCommand,
      cwd: '../idp',
      env: idpEnv,
      url: `${IDP_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: 'chat-server',
      command: `go build -o ${serverBin} ./cmd/server && ${serverBin} migrate up && node ../web/e2e-stack/reset-chat-db.mjs && ${serverBin} serve`,
      cwd: '../server',
      env: serverEnv,
      url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      name: 'web',
      // STACK_WEB_BUILD=1 serves the production build (soak runs measure that).
      command: process.env.STACK_WEB_BUILD
        ? `pnpm exec vite build && pnpm exec vite preview --port ${WEB_PORT} --strictPort`
        : `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      env: { CENACLE_DEV_API: `http://127.0.0.1:${SERVER_PORT}` },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
