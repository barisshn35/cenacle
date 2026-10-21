// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
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

let h: Harness;
test.beforeAll(async () => {
  h = await startHarness({ loginRateLimit: 3 });
});
test.afterAll(async () => {
  await h?.close();
});

test('too many sign-in attempts are rate limited, also for correct passwords', async ({ page }) => {
  const config = await client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    { execute: [client.allowInsecureRequests] },
  );
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: h.callbackUrl,
    scope: 'openid',
    code_challenge: await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier()),
    code_challenge_method: 'S256',
  });
  await page.goto(url.href);
  for (let i = 0; i < 3; i++) {
    await page.getByLabel('E-mail address').fill(EMAIL);
    await page.getByLabel('Password').fill(`wrong passphrase number ${i}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('incorrect');
  }
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Too many attempts.');
  await expect(page.getByRole('alert')).toContainText(/Wait \d+ seconds/);
  expect(page.url().startsWith(h.callbackUrl)).toBe(false);
});
