// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_WS,
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
} from './helpers';

/** A fake bot API: one workspace's bots, tokens and webhooks. */
async function mockBots(page: Page) {
  const bots: {
    id: string;
    user_id: string;
    name: string;
    description: string;
    disabled: boolean;
    created_at: string;
  }[] = [];
  const tokens: {
    id: string;
    name: string;
    scopes: string[];
    created_at: string;
    last_used_at: null;
    expires_at: string | null;
  }[] = [];
  const hooks: {
    id: string;
    name: string;
    kind: string;
    channel_id: string;
    channel_name: string;
    created_at: string;
    last_used_at: null;
  }[] = [];
  const now = '2026-10-21T10:00:00Z';
  await page.route(`**/api/workspaces/${DEFAULT_WS}/bots`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { bots } });
    const { name, description } = route.request().postDataJSON() as {
      name: string;
      description: string;
    };
    const bot = {
      id: '01a15e50-b0b0-7000-8000-000000000001',
      user_id: '01a15e50-b0b0-7000-8000-0000000000aa',
      name,
      description,
      disabled: false,
      created_at: now,
    };
    bots.push(bot);
    return route.fulfill({ status: 201, json: bot });
  });
  await page.route(/\/api\/bots\/[0-9a-f-]{36}$/, (route) => {
    Object.assign(bots[0]!, route.request().postDataJSON());
    return route.fulfill({ json: bots[0] });
  });
  await page.route(/\/api\/bots\/[0-9a-f-]{36}\/tokens(\/[0-9a-f-]{36})?$/, (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: { tokens } });
    if (req.method() === 'DELETE') {
      tokens.splice(0, tokens.length, ...tokens.filter((t) => !req.url().endsWith(t.id)));
      return route.fulfill({ status: 204 });
    }
    const input = req.postDataJSON() as { name: string; scopes: string[] };
    const token = {
      id: `01a15e50-70ce-7000-8000-00000000000${tokens.length}`,
      name: input.name,
      scopes: input.scopes,
      created_at: now,
      last_used_at: null,
      expires_at: '2027-10-21T10:00:00Z',
    };
    tokens.push(token);
    return route.fulfill({
      status: 201,
      json: { token, secret: 'cnb_secret-shown-once-0123456789' },
    });
  });
  await page.route(/\/api\/bots\/[0-9a-f-]{36}\/webhooks(\/[0-9a-f-]{36})?$/, (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: { webhooks: hooks } });
    if (req.method() === 'DELETE') {
      hooks.splice(0);
      return route.fulfill({ status: 204 });
    }
    const input = req.postDataJSON() as { name: string; kind: string; channel_id: string };
    const hook = {
      id: '01a15e50-40c4-7000-8000-000000000001',
      ...input,
      channel_name: 'General',
      created_at: now,
      last_used_at: null,
    };
    hooks.push(hook);
    return route.fulfill({
      status: 201,
      json: { webhook: hook, url: 'http://127.0.0.1:15173/api/hooks/cnh_secret' },
    });
  });
}

test.describe('integrations', () => {
  test.skip(({ isMobile }) => isMobile, 'the workspace menu is in the drawer on phones');

  test('an admin creates a bot, a token and a Jira webhook', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await mockBots(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Workspace menu/ }).click();
    await page.getByRole('menuitem', { name: 'Integrations' }).click();
    const dialog = page.getByRole('dialog', { name: 'Integrations' });
    await expect(dialog.getByText('No bots yet.')).toBeVisible();

    await dialog.getByRole('button', { name: 'New bot' }).click();
    await dialog.getByLabel('Name').fill('Jira');
    await dialog.getByRole('button', { name: 'Create bot' }).click();
    await expect(dialog.getByRole('heading', { name: 'Jira' })).toBeVisible();

    await dialog.getByLabel('Token name').fill('ci');
    await dialog.getByRole('button', { name: 'Create token' }).click();
    await expect(dialog.getByTestId('secret')).toHaveText('cnb_secret-shown-once-0123456789');
    await expect(dialog.getByTestId('token')).toContainText('messages:write');

    await dialog.getByLabel('Webhook name').fill('Jira');
    await dialog.getByLabel('Sends').selectOption('jira');
    await dialog.getByRole('button', { name: 'Create webhook' }).click();
    await expect(dialog.getByText(/In Jira: System → WebHooks/)).toBeVisible();
    await expect(dialog.getByTestId('webhook')).toContainText('Jira events → General');

    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');

    // Revoking is irreversible: confirm first, Cancel holds the focus.
    await dialog.getByRole('button', { name: 'Revoke token ci' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Revoke token "ci"?' });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Revoke token' }).click();
    await expect(dialog.getByTestId('token')).toHaveCount(0);

    // Disabling asks (S2) and can be undone by enabling.
    await dialog.getByRole('button', { name: 'Disable' }).click();
    await page
      .getByRole('alertdialog', { name: 'Disable Jira?' })
      .getByRole('button', { name: 'Disable bot' })
      .click();
    await expect(dialog.getByText(/This bot is disabled/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Enable' }).click();
    await expect(dialog.getByText(/This bot is disabled/)).toBeHidden();
  });

  test('members do not see Integrations', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Workspace menu/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Integrations' })).toHaveCount(0);
  });
});

test('messages of bots carry a badge', async ({ page }) => {
  const message = {
    ...mockMessage(1, 'Derleme tamam'),
    author: { id: '01a15e50-b0b0-7000-8000-0000000000aa', display_name: 'CI', is_bot: true },
  };
  await mockApi(page, { messages: [message] });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByTestId('message').first().getByTestId('bot-badge')).toHaveText('Bot');
});
