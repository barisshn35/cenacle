// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectTargetSizes, mockApi } from './helpers';

test('the system console shows the installation and sets the notification policy', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Settings opens from the sidebar on wide screens');
  await mockApi(page, { admin: true });
  await page.route('**/api/admin/overview', (route) =>
    route.fulfill({
      json: {
        version: '0.34.0',
        counts: {
          users: 120,
          active_users: 88,
          bots: 3,
          workspaces: 2,
          channels: 40,
          messages: 12345,
          files: 10,
          file_bytes: 5_000_000,
        },
        config: [
          { name: 'public_url', value: 'https://chat.example.com' },
          { name: 'oidc_client_secret', value: 'set' },
        ],
        jobs: [
          {
            kind: 'push_notifications',
            available: 0,
            running: 1,
            retryable: 0,
            discarded: 0,
            completed: 900,
          },
        ],
        failures: [],
      },
    }),
  );
  let signedOut = '';
  await page.route(/\/api\/admin\/users(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        users: [
          {
            id: '01a15e50-aaaa-7000-8000-000000000011',
            display_name: 'Ayşe Yılmaz',
            email: 'ayse@example.com',
            username: 'ayse',
            is_admin: false,
            guest: false,
            deactivated: false,
            last_seen_at: '2026-10-24T09:00:00Z',
            created_at: '2026-10-01T09:00:00Z',
            workspaces: 2,
            sessions: 3,
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/admin\/users\/[0-9a-f-]{36}\/sessions$/, (route) => {
    signedOut = route.request().url();
    return route.fulfill({ status: 204 });
  });
  let policy = { push_contents: 'full', email_contents: 'full' };
  await page.route('**/api/admin/notification-policy', (route) => {
    if (route.request().method() === 'PUT')
      policy = route.request().postDataJSON() as typeof policy;
    return route.fulfill({ json: policy });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System console' }).click();
  const console = page.getByRole('dialog', { name: 'System console' });
  await expect(console.getByText('12,345')).toBeVisible();
  await expect(console.getByText('https://chat.example.com')).toBeVisible();
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');

  await console.getByRole('tab', { name: /People/ }).click();
  await expect(console.getByTestId('console-person')).toContainText('Ayşe Yılmaz');
  await console.getByRole('button', { name: 'Sign Ayşe Yılmaz out everywhere' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await expect
    .poll(() => signedOut)
    .toContain('/api/admin/users/01a15e50-aaaa-7000-8000-000000000011/sessions');

  await console.getByRole('tab', { name: /Notifications/ }).click();
  await console.getByLabel('Nothing but that something came').check();
  await expect.poll(() => policy.push_contents).toBe('none');
});
