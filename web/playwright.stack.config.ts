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
import { generateKeyPairSync } from 'node:crypto';

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
const callsOn = process.env.STACK_CALLS === '1';
const mediaPort = 8380;
const controlPort = 8383;
if (callsOn) {
  for (const name of ['calls', 'control']) {
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      join(dir, `${name}-private.pem`),
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(dir, `${name}-public.pem`),
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
      { mode: 0o600 },
    );
  }
}
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
  : // Without V8's fast API calls, as the image runs it (nodejs/node#66870).
    'node --no-turbo-fast-api-calls --import tsx src/server.ts';

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
  // E-mail goes to the development Mailpit (meeting invitations are read there).
  CENACLE_SMTP_HOST: '127.0.0.1',
  CENACLE_SMTP_PORT: process.env.MAILPIT_SMTP_PORT ?? '11025',
  CENACLE_SMTP_FROM: 'Cenacle <chat@example.com>',
  CENACLE_SMTP_SECURITY: 'none',
  // Optional services: live captions (a whisper.cpp server) and an AI model
  // server with an embedding model (semantic search); their tests skip without.
  ...(process.env.STACK_CAPTIONS_URL
    ? { CENACLE_CAPTIONS_URL: process.env.STACK_CAPTIONS_URL }
    : {}),
  ...(process.env.STACK_AI_URL
    ? {
        CENACLE_AI_URL: process.env.STACK_AI_URL,
        CENACLE_AI_MODEL: process.env.STACK_AI_MODEL ?? 'tiny',
        CENACLE_AI_EMBEDDING_MODEL: process.env.STACK_AI_EMBEDDING_MODEL ?? '',
      }
    : {}),
  ...(callsOn
    ? {
        CENACLE_CALLS: 'on',
        CENACLE_CALLS_INTERNAL_ADDR: `127.0.0.1:${controlPort}`,
        CENACLE_CALLS_PRIVATE_KEY_FILE: join(dir, 'calls-private.pem'),
        CENACLE_MEDIA_CONTROL_PUBLIC_KEY_FILE: join(dir, 'control-public.pem'),
      }
    : {}),
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
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    ...(callsOn
      ? {
          launchOptions: {
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
          },
        }
      : {}),
  },
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
        ? `pnpm exec vite build && node --no-turbo-fast-api-calls node_modules/vite/bin/vite.js preview --port ${WEB_PORT} --strictPort`
        : `node --no-turbo-fast-api-calls node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort`,
      env: {
        CENACLE_DEV_API: `http://127.0.0.1:${SERVER_PORT}`,
        ...(callsOn ? { CENACLE_DEV_MEDIA: `http://127.0.0.1:${mediaPort}` } : {}),
      },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    ...(callsOn
      ? [
          {
            name: 'media',
            cwd: '../server',
            command: `go build -o ${join(dir, 'cenacle-media')} ./cmd/media/main.go && ${join(dir, 'cenacle-media')} serve`,
            env: {
              CENACLE_PUBLIC_URL: WEB_URL,
              CENACLE_MEDIA_HTTP_ADDR: `127.0.0.1:${mediaPort}`,
              CENACLE_MEDIA_PUBLIC_IP: required('STACK_CALLS_PUBLIC_IP'),
              // Not the usual ports, so a media node already running on the
              // host (a trial installation, another job) does not stop the run.
              CENACLE_MEDIA_ICE_UDP_ADDR: `:${process.env.STACK_CALLS_ICE_UDP_PORT ?? '17882'}`,
              CENACLE_MEDIA_ICE_TCP_ADDR: `:${process.env.STACK_CALLS_ICE_TCP_PORT ?? '17881'}`,
              CENACLE_MEDIA_CONTROL_URL: `http://127.0.0.1:${controlPort}/control`,
              CENACLE_CALLS_PUBLIC_KEY_FILE: join(dir, 'calls-public.pem'),
              CENACLE_MEDIA_CONTROL_PRIVATE_KEY_FILE: join(dir, 'control-private.pem'),
              CENACLE_VALKEY_ADDR: serverEnv.CENACLE_VALKEY_ADDR,
              CENACLE_VALKEY_PASSWORD: process.env.CENACLE_VALKEY_PASSWORD ?? '',
            },
            url: `http://127.0.0.1:${mediaPort}/readyz`,
            reuseExistingServer: false,
            timeout: 180000,
          },
        ]
      : []),
  ],
});
