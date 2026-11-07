// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectTargetSizes, GENERAL, mockApi } from './helpers';

const LINK = {
  id: '01a16300-0000-7000-8000-0000000000a1',
  name: 'Müşteri',
  created_at: '2026-10-24T10:00:00Z',
  expires_at: '2026-10-25T10:00:00Z',
  max_uses: null,
  uses: 0,
  guests: 0,
};

test('a channel manager creates a guest link and ends it', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'channel settings open from the header on wide screens');
  await mockApi(page, { admin: true });
  let links: (typeof LINK)[] = [];
  let created: Record<string, unknown> | undefined;
  await page.route(`**/api/channels/${GENERAL.id}/guest-links`, (route) => {
    if (route.request().method() === 'POST') {
      created = route.request().postDataJSON() as Record<string, unknown>;
      links = [LINK];
      return route.fulfill({ status: 201, json: { link: LINK, token: 'guest-token-1' } });
    }
    return route.fulfill({ json: { links } });
  });
  await page.route(`**/api/channels/${GENERAL.id}/guest-links/${LINK.id}`, (route) => {
    links = [];
    return route.fulfill({ status: 204 });
  });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Channel settings' });
  await dialog.getByRole('tab', { name: 'Members and roles' }).click();
  const section = dialog.getByTestId('guest-links');
  await section.getByLabel('For whom (optional)').fill('Müşteri');
  await section.getByLabel('Password', { exact: true }).fill('dogru-parola');
  await section.getByLabel('Ends after').selectOption({ label: '1 week' });
  await section.getByRole('button', { name: 'Create guest link' }).click();
  await expect(section.getByLabel('Guest link', { exact: true })).toHaveValue(
    /\/guest\/guest-token-1$/,
  );
  expect(created).toEqual({ name: 'Müşteri', password: 'dogru-parola', expires_in_hours: 168 });
  await expect(section.getByTestId('guest-link-list')).toContainText('Müşteri');
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await section.getByRole('button', { name: 'End link' }).click();
  await expect(section.getByTestId('guest-link-list')).toHaveCount(0);
});

test('someone from outside joins a channel with a guest link', async ({ page }, testInfo) => {
  let joined: unknown;
  await page.route('**/api/guest-links/guest-token-1', (route) => {
    if (route.request().method() === 'POST') {
      joined = route.request().postDataJSON();
      const body = joined as { password: string };
      return body.password === 'dogru-parola'
        ? route.fulfill({ status: 201, json: { channel_id: GENERAL.id } })
        : route.fulfill({
            status: 403,
            contentType: 'application/problem+json',
            json: {
              status: 403,
              code: 'wrong_password',
              title: 'Forbidden',
              detail: 'The password is not right.',
            },
          });
    }
    return route.fulfill({
      json: {
        channel_name: 'General',
        workspace_name: 'Cenacle',
        valid: true,
        expires_at: '2026-10-25T10:00:00Z',
      },
    });
  });
  await page.goto('/guest/guest-token-1');
  await expect(page.getByRole('heading', { name: 'Join #General' })).toBeVisible();
  await page.getByLabel('Your name').fill('Ziyaretçi');
  await page.getByLabel('Password').fill('yanlis');
  await page.getByRole('button', { name: 'Join as a guest' }).click();
  await expect(page.getByText('The password is not right.').first()).toBeVisible();
  await expectTargetSizes(page, testInfo);
  await expectNoAxeViolations(page);

  // Joined: the app opens the channel (the session cookie is set by the server).
  await mockApi(page);
  await page.getByLabel('Password').fill('dogru-parola');
  await page.getByRole('button', { name: 'Join as a guest' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${GENERAL.id}`));
  expect(joined).toEqual({ name: 'Ziyaretçi', password: 'dogru-parola' });
});

test('an ended guest link says so', async ({ page }) => {
  await page.route('**/api/guest-links/old-token', (route) =>
    route.fulfill({
      json: {
        channel_name: 'General',
        workspace_name: 'Cenacle',
        valid: false,
        expires_at: '2026-10-20T10:00:00Z',
      },
    }),
  );
  await page.goto('/guest/old-token');
  await expect(page.getByText('This guest link no longer works.')).toBeVisible();
  await expectNoAxeViolations(page);
});
