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
  await page.route(/\/api\/bots\/[0-9a-f-]{36}\/tokens\/[0-9a-f-]{36}\/rotate$/, (route) => {
    const { overlap_hours } = route.request().postDataJSON() as { overlap_hours: number };
    const old = tokens[0]!;
    const token = { ...old, id: '01a15e50-70ce-7000-8000-0000000000ff' };
    if (overlap_hours === 0) tokens.splice(0, 1);
    tokens.push(token);
    return route.fulfill({ status: 201, json: { token, secret: 'cnb_rotated-0123456789' } });
  });
  const commands: {
    id: string;
    trigger: string;
    url: string;
    description: string;
    hint: string;
    created_at: string;
  }[] = [];
  await page.route(/\/api\/bots\/[0-9a-f-]{36}\/commands(\/[0-9a-f-]{36})?$/, (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: { commands } });
    if (req.method() === 'DELETE') {
      commands.splice(0);
      return route.fulfill({ status: 204 });
    }
    const input = req.postDataJSON() as {
      trigger: string;
      url: string;
      description: string;
      hint: string;
    };
    const command = { id: '01a15e50-c0de-7000-8000-000000000001', ...input, created_at: now };
    commands.push(command);
    return route.fulfill({ status: 201, json: { command, secret: 'cns_command-secret-0123' } });
  });
  const subs: {
    id: string;
    url: string;
    events: string[];
    disabled: boolean;
    created_at: string;
  }[] = [];
  await page.route(/\/api\/bots\/[0-9a-f-]{36}\/subscriptions(\/[0-9a-f-]{36})?$/, (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: { subscriptions: subs } });
    const input = req.postDataJSON() as { url: string; events: string[] };
    const subscription = {
      id: '01a15e50-5ab5-7000-8000-000000000001',
      ...input,
      disabled: false,
      created_at: now,
    };
    subs.push(subscription);
    return route.fulfill({ status: 201, json: { subscription, secret: 'cns_events-secret-0123' } });
  });
  await page.route(
    /\/api\/bots\/[0-9a-f-]{36}\/subscriptions\/[0-9a-f-]{36}\/deliveries/,
    (route) =>
      route.fulfill({
        json: {
          has_more: false,
          deliveries: [
            {
              id: '01a15e50-de11-7000-8000-000000000001',
              event_type: 'message.created',
              status: 'failed',
              attempts: 8,
              last_status: 500,
              last_error: 'The receiver answered 500.',
              next_attempt_at: now,
              created_at: now,
              delivered_at: null,
            },
          ],
        },
      }),
  );
  let resent = 0;
  await page.route(/\/api\/bots\/[0-9a-f-]{36}\/deliveries\/[0-9a-f-]{36}\/resend$/, (route) => {
    resent++;
    return route.fulfill({ status: 204 });
  });
  return { resent: () => resent };
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

    await dialog.getByRole('button', { name: 'Incoming webhooks' }).click();
    await dialog.getByLabel('Webhook name').fill('Jira');
    await dialog.getByLabel('Sends').selectOption('jira');
    await dialog.getByRole('button', { name: 'Create webhook' }).click();
    await expect(dialog.getByText(/In Jira: System → WebHooks/)).toBeVisible();
    await expect(dialog.getByTestId('webhook')).toContainText('Jira events → General');

    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');

    // Revoking is irreversible: confirm first, Cancel holds the focus.
    await dialog.getByRole('button', { name: 'Tokens' }).click();
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

  test('slash commands, event subscriptions and token rotation', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    const api = await mockBots(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Workspace menu/ }).click();
    await page.getByRole('menuitem', { name: 'Integrations' }).click();
    const dialog = page.getByRole('dialog', { name: 'Integrations' });
    await dialog.getByRole('button', { name: 'New bot' }).click();
    await dialog.getByLabel('Name').fill('Deploy');
    await dialog.getByRole('button', { name: 'Create bot' }).click();

    // Rotating keeps the old token for the chosen overlap and shows the new secret.
    await dialog.getByLabel('Token name').fill('ci');
    await dialog.getByRole('button', { name: 'Create token' }).click();
    await dialog.getByRole('button', { name: 'Rotate token ci' }).click();
    const rotate = page.getByRole('alertdialog', { name: 'Rotate token "ci"?' });
    await rotate.getByLabel('The current token keeps working').selectOption('1');
    await rotate.getByRole('button', { name: 'Rotate' }).click();
    await expect(dialog.getByTestId('secret')).toHaveText('cnb_rotated-0123456789');
    await expect(dialog.getByTestId('token')).toHaveCount(2);

    await dialog.getByRole('button', { name: 'Commands' }).click();
    await dialog.getByLabel('Command', { exact: true }).fill('/deploy');
    await dialog.getByLabel('Request address').fill('https://ci.example.com/cenacle');
    await dialog.getByRole('button', { name: 'Add command' }).click();
    await expect(dialog.getByTestId('command')).toContainText('/deploy');
    await expect(dialog.getByTestId('secret')).toHaveText('cns_command-secret-0123');

    await dialog.getByRole('button', { name: 'Events' }).click();
    await dialog.getByLabel('Delivery address').fill('https://audit.example.com/in');
    await dialog.getByLabel('Reactions added').check();
    await dialog.getByRole('button', { name: 'Subscribe' }).click();
    await expect(dialog.getByTestId('subscription')).toContainText(
      'message.created, reaction.added',
    );
    await dialog.getByRole('button', { name: 'Deliveries' }).click();
    await expect(dialog.getByTestId('delivery')).toContainText('failed');
    await expect(dialog.getByTestId('delivery')).toContainText('HTTP 500');

    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');

    await dialog.getByRole('button', { name: 'Send again' }).click();
    await expect(page.getByText('It will be sent again shortly.')).toBeVisible();
    expect(api.resent()).toBe(1);
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
