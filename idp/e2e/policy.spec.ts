// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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
let lastStep = 0;

/** A code for a time step after the last accepted one (each code works once). */
async function freshCode(): Promise<string> {
  const step = () => Math.floor(Date.now() / 30_000);
  while (step() <= lastStep) await new Promise((r) => setTimeout(r, 500));
  lastStep = step();
  return generate({ secret });
}

// The v0.29 default: two-step verification required, passkeys off.
test.beforeAll(async () => {
  h = await startHarness({
    loginRateLimit: 1000,
    directory: true,
    policy: { requireTwoStep: true, passkeys: false },
  });
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

async function authorize(page: Page) {
  const config = await client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    { execute: [client.allowInsecureRequests] },
  );
  const verifier = client.randomPKCECodeVerifier();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: h.callbackUrl,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: client.randomState(),
  });
  await page.goto(url.href);
}

test('without two-step verification, signing in sets it up first', async ({ page }) => {
  await authorize(page);
  // Passkeys are off: only the password form.
  await expect(page.getByRole('button', { name: /passkey/i })).toHaveCount(0);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set up two-step verification');
  await expect(page.getByText('Your organization requires two-step verification')).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await axe(page);

  // A wrong code is refused and the setup stays.
  await page.getByRole('textbox', { name: 'Verification code' }).fill('000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s/g, '');
  await page.getByRole('textbox', { name: 'Verification code' }).fill(await freshCode());
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
  await axe(page);
  await page.getByRole('button', { name: 'I have saved the codes, continue' }).click();
  await expect.poll(() => h.callbacks.at(-1)?.get('code') ?? null).not.toBeNull();
});

test('the account sign-in offers no passkey while passkeys are off', async ({ page }) => {
  await page.goto(`${h.issuer}/account`);
  await expect(page.getByRole('button', { name: /passkey/i })).toHaveCount(0);
});

test('administrators change the sign-in policy', async ({ page }) => {
  // A fresh code may wait for the next 30-second step of the app.
  test.setTimeout(90_000);
  // Sign in to the account pages with a fresh code of the app set up above.
  await page.goto(`${h.issuer}/account`);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Verification code' }).fill(await freshCode());
  await page.getByRole('button', { name: 'Verify' }).click();
  // Required: there is no way to turn it off.
  await expect(page.getByTestId('two-step-state')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Turn off two-step verification' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Passkeys' })).toHaveCount(0);

  await page.goto(`${h.issuer}/account/admin/sign-in`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign-in policy');
  await expect(page.getByLabel('Require two-step verification')).toBeChecked();
  await expect(page.getByLabel('Allow passkeys')).not.toBeChecked();
  await axe(page);
  await page.getByLabel('Allow passkeys').check();
  await page.getByRole('button', { name: 'Save the policy' }).click();
  await expect(page.getByText('The sign-in policy is saved.')).toBeVisible();
  await expect(page.getByLabel('Allow passkeys')).toBeChecked();

  // Passkeys now show on the account page.
  await page.goto(`${h.issuer}/account`);
  await expect(page.getByRole('heading', { name: 'Passkeys' })).toBeVisible();
});
