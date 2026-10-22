// SPDX-License-Identifier: AGPL-3.0-only
//
// Passkeys with Chromium's virtual authenticator (WebAuthn over CDP): add one
// on the account page, sign in to an app and to the account page with it,
// remove it.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { decodeJwt } from 'jose';
import * as client from 'openid-client';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  DATABASE_URL,
  EMAIL,
  PASSWORD,
  startHarness,
  type Harness,
} from './harness.ts';

test.skip(!DATABASE_URL, 'IDP_TEST_DATABASE_URL is not set');
test.describe.configure({ mode: 'serial' });

let h: Harness;

test.beforeAll(async () => {
  h = await startHarness({ loginRateLimit: 1000, host: 'localhost' });
});
test.afterAll(async () => {
  await h?.close();
});

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .options({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'target-size': { enabled: true } },
    })
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
}

/** A platform authenticator that keeps passkeys and verifies the user. */
async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

let credential: Awaited<ReturnType<typeof exportCredential>>;

async function exportCredential(page: Page, a: Awaited<ReturnType<typeof authenticator>>) {
  const { credentials } = await a.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: a.authenticatorId,
  });
  expect(credentials).toHaveLength(1);
  return credentials[0]!;
}

/** Each test has a new browser context: put the passkey on its authenticator. */
async function withPasskey(page: Page) {
  const a = await authenticator(page);
  await a.cdp.send('WebAuthn.addCredential', {
    authenticatorId: a.authenticatorId,
    credential,
  });
  return a;
}

test('adding a passkey on the account page', async ({ page }) => {
  const a = await authenticator(page);
  await page.goto(`${h.issuer}/account`);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('no-passkeys')).toBeVisible();
  await axe(page);

  await page.getByLabel('Name of the passkey').fill('Work laptop');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('The passkey is added.')).toBeVisible();
  await expect(page.getByTestId('passkeys')).toContainText('Work laptop');
  await axe(page);
  credential = await exportCredential(page, a);
});

test('signing in to an app with a passkey', async ({ page }) => {
  const a = await withPasskey(page);
  const config = await client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    { execute: [client.allowInsecureRequests] },
  );
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: h.callbackUrl,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  });
  await page.goto(url.href);
  await axe(page);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('client callback')).toBeVisible();

  const params = h.callbacks.at(-1)!;
  const tokens = await client.authorizationCodeGrant(
    config,
    new URL(`${h.callbackUrl}?${params.toString()}`),
    { pkceCodeVerifier: verifier, expectedState: state },
  );
  expect(decodeJwt(tokens.id_token!).sub).toBeTruthy();
  const { rows } = await h.pool.query<{ detail: { method?: string } }>(
    "SELECT detail FROM audit_events WHERE action = 'signin.succeeded' ORDER BY at DESC LIMIT 1",
  );
  expect(rows[0]?.detail.method).toBe('passkey');
  // Its signature counter went up: the next test takes it from here (an older
  // copy would be refused as a cloned authenticator).
  credential = await exportCredential(page, a);
  const info = await client.fetchUserInfo(config, tokens.access_token, client.skipSubjectCheck);
  expect(info.email).toBe(EMAIL);
});

test('a passkey the account no longer has does not sign in', async ({ page, browser }) => {
  // Sign in to the account page with the passkey, remove it there.
  await withPasskey(page);
  await page.goto(`${h.issuer}/account`);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByTestId('passkeys')).toContainText('Work laptop');
  await page.getByRole('button', { name: 'Remove Work laptop' }).click();
  await expect(page.getByText('The passkey is removed.')).toBeVisible();
  await expect(page.getByTestId('no-passkeys')).toBeVisible();

  // The authenticator still has it; Cenacle ID refuses it.
  const other = await browser.newPage();
  await withPasskey(other);
  await other.goto(`${h.issuer}/account`);
  await other.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(other.getByRole('alert')).toContainText('Signing in with a passkey did not work.');
  await other.close();
});
