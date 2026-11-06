// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
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

const POLICY = 'https://example.com/privacy';

let h: Harness;

test.beforeAll(async () => {
  h = await startHarness({ loginRateLimit: 1000, privacyUrl: POLICY });
});
test.afterAll(async () => {
  await h?.close();
});

async function expectPolicyLink(page: Page, name: RegExp) {
  const link = page.getByRole('contentinfo').getByRole('link', { name });
  await expect(link).toHaveAttribute('href', POLICY);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
}

test('the sign-in page links the privacy policy (IDP_PRIVACY_URL)', async ({ page }) => {
  const config = await client.discovery(
    new URL(h.issuer),
    CLIENT_ID,
    undefined,
    client.ClientSecretBasic(CLIENT_SECRET),
    { execute: [client.allowInsecureRequests] },
  );
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: h.callbackUrl,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier()),
    code_challenge_method: 'S256',
    state: client.randomState(),
  });
  await page.goto(url.href);
  await expect(page.getByLabel('E-mail address')).toBeVisible();
  await expectPolicyLink(page, /^Privacy policy \(opens in a new tab\)$/);
});

test('the account pages link it in English and Turkish', async ({ page }) => {
  await page.goto(`${h.issuer}/account?lang=tr`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expectPolicyLink(page, /^Gizlilik politikası \(yeni sekmede açılır\)$/);

  await page.goto(`${h.issuer}/account?lang=en`);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel('E-mail address')).toHaveCount(0);
  await expectPolicyLink(page, /^Privacy policy \(opens in a new tab\)$/);
});

test('without IDP_PRIVACY_URL there is no link', async ({ page }) => {
  await h.close();
  h = await startHarness({ loginRateLimit: 1000 });
  await page.goto(`${h.issuer}/account`);
  await expect(page.getByLabel('E-mail address')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await expect(page.getByRole('contentinfo').getByRole('link')).toHaveCount(0);
});
