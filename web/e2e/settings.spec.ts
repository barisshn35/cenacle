// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { DEVICES, expectNoAxeViolations, expectTargetSizes, mockApi, SESSION } from './helpers';

test.describe('settings: devices and security', () => {
  test.skip(({ isMobile }) => isMobile, 'the settings button is in the drawer on phones');

  test('lists devices and signs one out', async ({ page }, testInfo) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });

    const devices = dialog.getByTestId('device');
    await expect(devices).toHaveCount(3);
    await expect(devices.nth(0)).toContainText('Opera on Windows');
    await expect(devices.nth(0)).toContainText('This device');
    await expect(devices.nth(1)).toContainText('Safari on iOS');
    await expect(devices.nth(2)).toContainText('Firefox on Linux');
    // The current device cannot be signed out here (use "Sign out").
    await expect(devices.nth(0).getByRole('button')).toHaveCount(0);

    const link = dialog.getByRole('link', { name: /Open Cenacle ID/ });
    await expect(link).toHaveAttribute('href', SESSION.account_url);
    await expect(link).toHaveAttribute('target', '_blank');

    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');

    await dialog.getByRole('button', { name: 'Sign out Safari on iOS' }).click();
    await expect(page.getByText('Safari on iOS was signed out.')).toBeVisible();
    await expect(devices).toHaveCount(2);
    expect(api.ended).toEqual([DEVICES[1]!.id]);
  });

  test('"Sign out everywhere" asks first and can keep this device', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Sign out everywhere' }).click();

    const confirm = page.getByRole('alertdialog', { name: 'Sign out everywhere?' });
    await expect(confirm).toContainText('2 other devices are signed in.');
    // Cancel holds the focus (glossary rule 2).
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(confirm.getByLabel('Keep me signed in on this device')).toBeChecked();
    await confirm.getByRole('button', { name: 'Sign out everywhere' }).click();

    await expect(page.getByText('2 devices were signed out.')).toBeVisible();
    expect(api.ended).toEqual(['others']);
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByTestId('device')).toHaveCount(
      1,
    );
  });

  test('signing out everywhere including this device leads to the sign-in page', async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Sign out everywhere' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Sign out everywhere?' });
    await confirm.getByLabel('Keep me signed in on this device').uncheck();
    // The server now answers that the session has ended.
    await page.unroute('**/api/session');
    await page.route('**/api/session', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          code: 'unauthenticated',
        }),
      }),
    );
    await confirm.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page).toHaveURL(/\/signin\?error=session_expired/);
    await expect(page.getByRole('status')).toContainText('Your session has ended.');
    expect(api.ended).toEqual(['all']);
  });

  test('a session ended elsewhere leads to the sign-in page once', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'Message General' })).toBeVisible();
    await page.unroute('**/api/session');
    await page.route('**/api/session', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          code: 'unauthenticated',
        }),
      }),
    );
    api.closeSocket(4003); // the server ended the session
    await expect(page).toHaveURL(/\/signin\?error=session_expired&return_to=%2Fc%2F/);
    await expect(page.getByRole('status')).toContainText('Your session has ended.');
  });
});
