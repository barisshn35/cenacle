// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  SESSION,
  VARIANTS,
  expectNoAxeViolations,
  expectTargetSizes,
  mockApi,
  mockSession,
} from './helpers';

const continueLink = (page: import('@playwright/test').Page) =>
  page.getByRole('link', { name: 'Continue with Cenacle ID' });

test('signed-out users are sent to sign-in, keeping their place', async ({ page }) => {
  await mockSession(page, null);
  await page.goto('/?channel=general');
  await expect(page).toHaveURL(/\/signin\?return_to=/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to Cenacle');
  await expect(continueLink(page)).toHaveAttribute(
    'href',
    `/api/auth/login?return_to=${encodeURIComponent('/?channel=general')}`,
  );
  // No error is shown for a plain visit.
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('return_to never leaves the app', async ({ page }) => {
  await mockSession(page, null);
  await page.goto(`/signin?return_to=${encodeURIComponent('//evil.example/x')}`);
  await expect(continueLink(page)).toHaveAttribute('href', '/api/auth/login');
});

test('a signed-in user skips the sign-in page', async ({ page }) => {
  await mockApi(page);
  await page.goto('/signin');
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('General');
});

for (const [error, role, text] of [
  ['cancelled', 'status', 'Sign-in was cancelled.'],
  ['expired', 'alert', 'This sign-in has expired.'],
  ['failed', 'alert', 'Sign-in could not be completed.'],
  ['unavailable', 'alert', "Cenacle ID can't be reached right now."],
  ['session_expired', 'status', 'Your session has ended.'],
] as const) {
  test(`sign-in outcome "${error}" is explained`, async ({ page }) => {
    await mockSession(page, null);
    await page.goto(`/signin?error=${error}&return_to=/`);
    await expect(page.getByRole(role).filter({ hasText: text })).toBeVisible();
    await expect(continueLink(page)).toBeVisible();
  });
}

test('unknown error values are ignored', async ({ page }) => {
  await mockSession(page, null);
  await page.goto('/signin?error=<script>');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const v of VARIANTS) {
  test(`sign-in page ${v.theme}/${v.density}: target size and axe`, async ({ page }, testInfo) => {
    await mockSession(page, null);
    await page.emulateMedia({ colorScheme: v.theme });
    await page.addInitScript((d) => localStorage.setItem('cenacle.density', d), v.density);
    await page.goto('/signin?error=failed');
    await expect(page.locator('html')).toHaveAttribute('data-theme', v.theme);
    await expectTargetSizes(page, testInfo);
    await expectNoAxeViolations(page);
  });
}

test('the server being unreachable is not mistaken for signed out', async ({ page }) => {
  let down = true;
  await mockApi(page);
  await page.route('**/api/session', (route) =>
    down ? route.abort('connectionrefused') : route.fulfill({ json: SESSION }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText("Can't reach Cenacle.");
  await expect(page).not.toHaveURL(/signin/);
  down = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('General');
});

test('signing out ends the session and opens the Cenacle ID sign-out page', async ({
  page,
  isMobile,
}) => {
  await mockApi(page);
  let logoutOrigin: string | undefined;
  await page.route('**/api/auth/logout', async (route) => {
    logoutOrigin = route.request().headers()['origin'];
    await page.unroute('**/api/session');
    await mockSession(page, null);
    await route.fulfill({ json: { end_session_url: '' } });
  });
  await page.goto('/');
  // On narrow screens the user card is in the channel drawer.
  if (isMobile) await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  await expect(page.getByTestId('current-user')).toHaveText('Deniz Kaya');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin$/);
  expect(logoutOrigin).toBe(new URL(page.url()).origin);
});
