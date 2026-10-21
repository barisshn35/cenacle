// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { IDP_URL, WEB_URL, idpEnv } from '../playwright.stack.config';

const EMAIL = 'deniz@example.com';
const PASSWORD = 'e2e stack password 2026';

/** Creates the account at Cenacle ID with its CLI (or resets its password). */
function ensureAccount() {
  const run = (args: string[]) =>
    execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], {
      cwd: '../idp',
      env: { ...process.env, ...idpEnv },
      input: `${PASSWORD}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  try {
    run(['users', 'create', '--email', EMAIL, '--name', 'Deniz Kaya', '--verified']);
  } catch {
    run(['users', 'set-password', '--email', EMAIL]);
  }
}

test.beforeAll(ensureAccount);

async function signInAtIdP(page: Page) {
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByLabel('E-mail address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('signing in with Cenacle ID and out again', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname)) external.push(r.url());
  });

  // A deep link survives the round trip through Cenacle ID.
  await page.goto('/?channel=deploys');
  await expect(page).toHaveURL(/\/signin\?return_to=/);
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await signInAtIdP(page);
  await expect(page).toHaveURL(`${WEB_URL}/?channel=deploys`);
  await expect(page.getByTestId('current-user')).toHaveText('Deniz Kaya');

  const cookie = (await page.context().cookies(WEB_URL)).find((c) => c.name === 'cenacle_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

  // The session outlives a reload.
  await page.reload();
  await expect(page.getByTestId('current-user')).toHaveText('Deniz Kaya');

  // Signing out ends the chat session and, after confirming, the Cenacle ID session.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin$/);
  expect((await page.request.get('/api/session')).status()).toBe(401);

  // Signing in again asks for the password: single sign-on ended too.
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
  expect(external).toEqual([]);
});

test('cancelling at Cenacle ID returns to the sign-in page with an explanation', async ({
  page,
}) => {
  await page.goto('/signin');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page).toHaveURL(/\/signin\?error=cancelled/);
  await expect(page.getByRole('status')).toContainText('Sign-in was cancelled.');
});

test('a session cannot be used from another origin', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await signInAtIdP(page);
  await expect(page.getByTestId('current-user')).toBeVisible();
  const token = (await page.context().cookies(WEB_URL)).find(
    (c) => c.name === 'cenacle_session',
  )!.value;

  const res = await request.post(`${WEB_URL}/api/auth/logout`, {
    headers: { Cookie: `cenacle_session=${token}`, Origin: 'https://evil.example' },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).code).toBe('cross_site_request');
  // Still signed in.
  expect((await page.request.get('/api/session')).status()).toBe(200);
});
