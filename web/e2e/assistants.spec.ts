// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { GENERAL, mockApi, expectNoAxeViolations } from './helpers';

const TOKEN = 'cnp_' + 'a'.repeat(43);

test('a person makes an assistant token, sees it once and revokes it', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the settings open from the sidebar on phones');
  await mockApi(page);
  const tokens: Record<string, unknown>[] = [];
  let made: Record<string, unknown> | null = null;
  await page.route('**/api/me/assistants', (route) => {
    if (route.request().method() === 'POST') {
      made = route.request().postDataJSON();
      const t = {
        id: '01a16800-0000-7000-8000-000000000001',
        name: 'Desk',
        scopes: ['read', 'draft'],
        created_at: '2026-11-13T09:00:00Z',
        expires_at: '2026-12-13T09:00:00Z',
        last_used_at: null,
      };
      tokens.push(t);
      return route.fulfill({ status: 201, json: { ...t, token: TOKEN } });
    }
    return route.fulfill({
      json: { allowed: true, mcp_url: 'http://localhost/api/mcp', tokens },
    });
  });
  let revoked = false;
  await page.route('**/api/me/assistants/*', (route) => {
    revoked = true;
    tokens.length = 0;
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Assistants' }).click();
  await expect(dialog).toContainText('An assistant never sends, edits or deletes a message');
  await dialog.getByLabel('Name').fill('Desk');
  await dialog.getByLabel('Leave drafts in message boxes').check();
  await dialog.getByRole('button', { name: 'Make the token' }).click();
  await expect(dialog.getByLabel('Token', { exact: true })).toHaveValue(TOKEN);
  await expect(dialog.locator('pre')).toContainText('"Authorization": "Bearer ' + TOKEN);
  expect(made).toEqual({ name: 'Desk', scopes: ['read', 'draft'], days: 30 });
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog.getByLabel('Token', { exact: true })).toHaveCount(0);
  await expect(dialog).toContainText('Reads and drafts');
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect.poll(() => revoked).toBe(true);
  await expect(dialog).toContainText('No tokens yet.');
});

test('the settings show no assistants where the server does not allow them', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the settings open from the sidebar on phones');
  await mockApi(page);
  await page.route('**/api/me/assistants', (route) =>
    route.fulfill({ json: { allowed: false, mcp_url: 'http://localhost/api/mcp', tokens: [] } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('tab', { name: 'Notifications' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Assistants' })).toHaveCount(0);
});

test('an assistant’s draft waits above the message box until the person uses it', async ({
  page,
}) => {
  const api = await mockApi(page);
  let drafts = [
    {
      channel_id: GENERAL.id,
      root_id: null,
      body: 'I can review it on Monday.',
      created_at: '2026-11-13T09:00:00Z',
      assistant: 'Desk',
    },
  ];
  let dropped = false;
  await page.route('**/api/me/assistant-drafts', (route) => route.fulfill({ json: { drafts } }));
  await page.route(`**/api/me/assistant-drafts/${GENERAL.id}`, (route) => {
    dropped = true;
    drafts = [];
    return route.fulfill({ status: 204 });
  });
  await page.goto(`/c/${GENERAL.id}`);
  const bar = page.getByTestId('assistant-draft');
  await expect(bar).toContainText('Desk drafted this. Nothing is sent until you send it.');
  await expect(bar).toContainText('I can review it on Monday.');
  await expectNoAxeViolations(page);
  await bar.getByRole('button', { name: 'Put in the message box' }).click();
  await expect(page.getByRole('textbox', { name: 'Message General' })).toHaveValue(
    'I can review it on Monday.',
  );
  await expect.poll(() => dropped).toBe(true);
  await expect(bar).toHaveCount(0);
  // A new draft arrives live.
  drafts = [
    {
      channel_id: GENERAL.id,
      root_id: null,
      body: 'Second thought',
      created_at: '2026-11-13T09:05:00Z',
      assistant: 'Desk',
    },
  ];
  api.emit('assistant.draft', { to: [] });
  await expect(page.getByTestId('assistant-draft')).toContainText('Second thought');
});
