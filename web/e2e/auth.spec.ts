// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  GENERAL,
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

test('sign-in names this server and the steps that follow', async ({ page }, testInfo) => {
  await mockSession(page, null);
  await page.goto('/signin');
  await expect(page.getByTestId('signin-server')).toHaveText(new URL(page.url()).host);
  if (!testInfo.project.name.includes('coarse')) {
    const steps = page.getByRole('complementary', { name: 'Signing in' });
    await expect(steps.getByRole('listitem')).toHaveText([
      '1Server',
      '2Username and password',
      '3Code from your authenticator app',
    ]);
  } else {
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
  }
  await expectNoAxeViolations(page);
  await expectTargetSizes(page, testInfo);
});

test('with the web app off, browsers are told to use the apps', async ({ page }, testInfo) => {
  await mockSession(page, null);
  await page.route('**/api/meta', (route) => route.fulfill({ json: { web_app: false } }));
  await page.goto('/signin');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Use the Cenacle app');
  await expect(page.getByTestId('web-off')).toContainText(new URL(page.url()).host);
  await expect(continueLink(page)).toHaveCount(0);
  await expectNoAxeViolations(page);
  await expectTargetSizes(page, testInfo);

  // The server also sends sign-ins started anyway back with web_app_off.
  await page.unroute('**/api/meta');
  await page.route('**/api/meta', (route) => route.fulfill({ json: { web_app: true } }));
  await page.goto('/signin?error=web_app_off');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Use the Cenacle app');
});

test('a browser turned away while signed in shows the same page', async ({ page }) => {
  await mockApi(page);
  await page.unroute('**/api/session');
  await page.route('**/api/session', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      json: { type: 'about:blank', status: 403, code: 'web_app_off', title: 'Forbidden' },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Use the Cenacle app');
});

test('server administrators turn the web app off after confirming', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('coarse'), 'Settings opens from the rail on desktop');
  await mockApi(page, { admin: true });
  let enabled = true;
  const puts: boolean[] = [];
  await page.route('**/api/admin/web-app', async (route) => {
    if (route.request().method() === 'PUT') {
      enabled = (route.request().postDataJSON() as { enabled: boolean }).enabled;
      puts.push(enabled);
    }
    await route.fulfill({ json: { enabled, forced: false } });
  });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Sign-in' }).click();
  const toggle = dialog.getByRole('switch', { name: 'Allow web browsers' });
  await expect(toggle).toBeChecked();
  await expect(dialog.getByRole('link', { name: /Open sign-in policy/ })).toHaveAttribute(
    'href',
    /\/account\/admin\/sign-in$/,
  );

  await toggle.click();
  const confirm = page.getByRole('alertdialog', { name: 'Turn off Cenacle in web browsers?' });
  await expect(confirm).toContainText('CENACLE_WEB_APP=on');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(puts).toEqual([]);
  await expect(toggle).toBeChecked();

  await toggle.click();
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect.poll(() => puts).toEqual([false]);
});
