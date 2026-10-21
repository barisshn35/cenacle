// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { IDP_URL, WEB_URL, idpEnv } from '../playwright.stack.config';

const EMAIL = 'deniz@example.com';
const PASSWORD = 'e2e stack password 2026';
const SECOND = { email: 'mert@example.com', name: 'Mert Demir' };

/** Creates an account at Cenacle ID with its CLI (or resets its password). */
function ensureAccount(email = EMAIL, name = 'Deniz Kaya') {
  const run = (args: string[]) =>
    execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], {
      cwd: '../idp',
      env: { ...process.env, ...idpEnv },
      input: `${PASSWORD}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  try {
    run(['users', 'create', '--email', email, '--name', name, '--verified']);
  } catch {
    run(['users', 'set-password', '--email', email]);
  }
}

test.beforeAll(() => {
  ensureAccount();
  ensureAccount(SECOND.email, SECOND.name);
});

async function signInAtIdP(page: Page, email = EMAIL) {
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByLabel('E-mail address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('signing in with Cenacle ID and out again', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname)) external.push(r.url());
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await signInAtIdP(page);
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/); // General
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

test('two people chat live, also after a reconnect', async ({ browser }) => {
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  const deniz = await open(EMAIL);
  const mert = await open(SECOND.email);
  const stamp = Date.now().toString(36);

  await deniz.getByLabel('Message General').fill(`Merhaba Mert ${stamp}`);
  await deniz.getByLabel('Message General').press('Enter');
  await expect(mert.getByText(`Merhaba Mert ${stamp}`)).toBeVisible();

  // Mert loses the connection; a message sent meanwhile arrives after it is back.
  await mert.context().setOffline(true);
  await expect(mert.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
  await deniz.getByLabel('Message General').fill(`Kaçırma bunu ${stamp}`);
  await deniz.getByLabel('Message General').press('Enter');
  await mert.context().setOffline(false);
  await expect(mert.getByText(`Kaçırma bunu ${stamp}`)).toBeVisible();
  await expect(mert.getByText(`Kaçırma bunu ${stamp}`)).toHaveCount(1);

  await mert.getByLabel('Message General').fill(`Selam Deniz ${stamp}`);
  await mert.getByLabel('Message General').press('Enter');
  await expect(deniz.getByText(`Selam Deniz ${stamp}`)).toBeVisible();
});

test('Central is for announcements; only the administrator creates channels', async ({
  browser,
}) => {
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  // deniz@example.com is CENACLE_ADMIN_EMAIL in this stack.
  const admin = await open(EMAIL);
  const member = await open(SECOND.email);
  const stamp = Date.now().toString(36);

  // Everyone is in Central; only the administrator can write there.
  await member.getByRole('link', { name: 'Central' }).click();
  await expect(member.getByTestId('read-only-notice')).toBeVisible();
  await admin.getByRole('link', { name: 'Central' }).click();
  await admin.getByLabel('Message Central').fill(`Duyuru ${stamp}`);
  await admin.getByLabel('Message Central').press('Enter');
  await expect(member.getByText(`Duyuru ${stamp}`)).toBeVisible();

  // Only the administrator sees "Create a channel".
  await expect(member.getByRole('button', { name: 'Create a channel' })).toHaveCount(0);
  await admin.getByRole('button', { name: 'Create a channel' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Create a channel' });
  await dialog.getByLabel('Name').fill(`Release ${stamp}`);
  await dialog.getByRole('button', { name: 'Create channel' }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText(`Release ${stamp}`);

  // Others find it and join; messages then reach them live.
  await member.getByRole('button', { name: 'Browse channels' }).click();
  await member.getByRole('button', { name: `Join Release ${stamp}` }).click();
  await expect(member.getByRole('heading', { level: 1 })).toHaveText(`Release ${stamp}`);
  await admin.getByLabel(`Message Release ${stamp}`).fill('sürüm çıktı');
  await admin.getByLabel(`Message Release ${stamp}`).press('Enter');
  await expect(member.getByText('sürüm çıktı')).toBeVisible();
});
