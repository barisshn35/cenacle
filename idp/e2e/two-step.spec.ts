// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { decodeJwt } from 'jose';
import * as client from 'openid-client';
import { generate } from 'otplib';
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
let secret = '';
let recovery: string[] = [];

test.beforeAll(async () => {
  h = await startHarness({ loginRateLimit: 1000 });
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

/** A code for a time step after the last accepted one (each code works once). */
async function freshCode(after = 0): Promise<string> {
  const step = () => Math.floor(Date.now() / 30_000);
  while (step() <= after) await new Promise((r) => setTimeout(r, 500));
  return generate({ secret });
}

async function signInToAccount(page: Page) {
  await page.goto(`${h.issuer}/account`);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function rp() {
  return client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    { execute: [client.allowInsecureRequests] },
  );
}

async function startAuthorization(page: Page) {
  const config = await rp();
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
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  return { config, verifier, state };
}

test('turning on two-step verification on the account page', async ({ page }) => {
  await signInToAccount(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your Cenacle ID');
  await expect(page.getByTestId('two-step-state')).toContainText('Off');
  await axe(page);

  await page.getByRole('link', { name: 'Set up two-step verification' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await axe(page);

  // A wrong code explains itself; the right one turns it on and shows recovery codes.
  await page.getByLabel('Verification code').fill('000000');
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.getByRole('alert')).toContainText('The code was not accepted.');
  await page.getByLabel('Verification code').fill(await freshCode());
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Save your recovery codes');
  recovery = (await page.getByTestId('recovery-codes').locator('li').allTextContents()).map((c) =>
    c.trim(),
  );
  expect(recovery).toHaveLength(10);
  await page.getByRole('link', { name: 'I have saved the codes' }).click();
  await expect(page.getByTestId('two-step-state')).toContainText('On');
  await expect(page.getByText('10 recovery codes left.')).toBeVisible();
  await expect(page.getByText('Two-step verification turned on')).toBeVisible();
});

test('signing in to an app then needs the second step', async ({ page }) => {
  const auth = await startAuthorization(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Two-step verification');
  await axe(page);

  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('4 attempts left');
  await expect(page.getByLabel('Verification code')).toHaveAttribute('aria-invalid', 'true');

  // A recovery code works (typed in upper case, without the dash).
  await page.getByLabel('Verification code').fill(recovery[0]!.replace('-', '').toUpperCase());
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((u) => u.href.startsWith(h.callbackUrl));
  const tokens = await client.authorizationCodeGrant(auth.config, new URL(page.url()), {
    pkceCodeVerifier: auth.verifier,
    expectedState: auth.state,
  });
  const claims = tokens.claims()!;
  // The session id lets the app end exactly this sign-in later (back-channel logout).
  expect(typeof claims.sid).toBe('string');

  // Signing out at Cenacle ID tells the app over the back channel, naming the session.
  const url = client.buildEndSessionUrl(auth.config, {
    id_token_hint: tokens.id_token!,
    post_logout_redirect_uri: h.postLogoutUrl,
  });
  await page.goto(url.href);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL((u) => u.href.startsWith(h.postLogoutUrl));
  await expect.poll(() => h.logoutTokens.length).toBe(1);
  const logout = decodeJwt(h.logoutTokens[0]!);
  expect(logout).toMatchObject({ iss: h.issuer, aud: CLIENT_ID, sub: claims.sub, sid: claims.sid });
  expect(logout.events).toEqual({ 'http://schemas.openid.net/event/backchannel-logout': {} });
});

test('a recovery code works once; an app code works too', async ({ page }) => {
  await startAuthorization(page);
  await page.getByLabel('Verification code').fill(recovery[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('The code was not accepted.');

  const { rows } = await h.pool.query<{ step: string }>(
    'SELECT totp_last_step::text AS step FROM users',
  );
  await page.getByLabel('Verification code').fill(await freshCode(Number(rows[0]!.step)));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((u) => u.href.startsWith(h.callbackUrl));
});

test('turning it off needs a current code', async ({ page }) => {
  await signInToAccount(page);
  await page.getByLabel('Verification code').fill(recovery[1]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('8 recovery codes left.')).toBeVisible();

  await page.getByRole('link', { name: 'Turn off two-step verification' }).click();
  await axe(page);
  await page.getByLabel('Verification code').fill(recovery[1]!); // used already
  await page.getByRole('button', { name: 'Turn off two-step verification' }).click();
  await expect(page.getByRole('alert')).toContainText('The code was not accepted.');
  await page.getByLabel('Verification code').fill(recovery[2]!);
  await page.getByRole('button', { name: 'Turn off two-step verification' }).click();
  await expect(page.getByRole('status')).toHaveText('Two-step verification is off.');
  await expect(page.getByTestId('two-step-state')).toContainText('Off');
});

test('changing the name on the account page', async ({ page }) => {
  await signInToAccount(page);
  await page.getByLabel('Your name').fill('Ayşe Y. Demir');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('status')).toContainText('Your name is saved');
  await expect(page.getByText('Ayşe Y. Demir ·')).toBeVisible();
  await axe(page);
  await page.getByLabel('Your name').fill('   ');
  await page.getByLabel('Your name').evaluate((el) => el.removeAttribute('required'));
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a name');
});
