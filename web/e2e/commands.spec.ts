// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_WS,
  GENERAL,
  expectNoAxeViolations,
  expectTargetSizes,
  mockApi,
  mockMessage,
} from './helpers';

const composer = (page: Page) => page.getByLabel('Message General');

const COMMANDS = [
  {
    trigger: 'remind',
    description: 'Get a reminder from Cenacle',
    hint: 'me in 10m …',
    builtin: true,
  },
  { trigger: 'shrug', description: 'Add ¯\\_(ツ)_/¯', hint: 'text', builtin: true },
  { trigger: 'deploy', description: 'Deploy a service', hint: 'service env', builtin: false },
];

async function mockCommands(page: Page) {
  const runs: { command: string; text: string; timezone: string }[] = [];
  const scheduled: Record<string, unknown>[] = [];
  await page.route(`**/api/workspaces/${DEFAULT_WS}/commands`, (route) =>
    route.fulfill({ json: { commands: COMMANDS } }),
  );
  await page.route(`**/api/channels/${GENERAL.id}/commands`, (route) => {
    const input = route.request().postDataJSON() as (typeof runs)[number];
    runs.push(input);
    if (input.command === 'nope') {
      return route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: { status: 404, code: 'unknown_command', title: 'Not Found' },
      });
    }
    if (input.command === 'shrug') {
      return route.fulfill({
        json: {
          response_type: 'in_channel',
          message: mockMessage(40, `${input.text} ¯\\\\\\_(ツ)\\_/¯`, 'Deniz Acar'),
        },
      });
    }
    return route.fulfill({
      json: { response_type: 'ephemeral', text: `I will remind you: **${input.text}**` },
    });
  });
  await page.route(`**/api/channels/${GENERAL.id}/scheduled`, (route) => {
    const { body, send_at } = route.request().postDataJSON() as { body: string; send_at: string };
    const item = {
      id: `01a15e50-5c4e-7000-8000-00000000000${scheduled.length}`,
      kind: 'message',
      channel_id: GENERAL.id,
      channel_name: 'General',
      workspace_id: DEFAULT_WS,
      body,
      send_at,
    };
    scheduled.push(item);
    return route.fulfill({ status: 201, json: item });
  });
  await page.route('**/api/scheduled', (route) => route.fulfill({ json: { scheduled } }));
  await page.route(/\/api\/scheduled\/[0-9a-f-]{36}$/, (route) => {
    scheduled.splice(0);
    return route.fulfill({ status: 204 });
  });
  return { runs };
}

test('slash commands: suggestions, answers only for you, messages in the channel', async ({
  page,
}, testInfo) => {
  await mockApi(page);
  const { runs } = await mockCommands(page);
  await page.goto('/');

  await composer(page).fill('/');
  const list = page.getByRole('listbox', { name: 'Commands' });
  await expect(list.getByRole('option')).toHaveCount(3);
  await composer(page).pressSequentially('re');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expectTargetSizes(page, testInfo, 'footer');
  await expectNoAxeViolations(page, 'footer');
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('/remind ');

  await composer(page).pressSequentially('me in 10m stand up');
  await composer(page).press('Enter');
  const note = page.getByTestId('command-note');
  await expect(note).toContainText('Only you see this · /remind');
  await expect(note.locator('strong')).toHaveText('me in 10m stand up');
  expect(runs[0]).toMatchObject({ command: 'remind', text: 'me in 10m stand up' });
  expect(runs[0]!.timezone).toBeTruthy();
  await expect(composer(page)).toHaveValue('');
  await note.getByRole('button', { name: 'Dismiss' }).click();
  await expect(note).toHaveCount(0);

  await composer(page).fill('/shrug olur');
  await composer(page).press('Enter');
  await expect(page.getByRole('log').getByText('olur ¯\\_(ツ)_/¯')).toBeVisible();

  await composer(page).fill('/nope');
  await composer(page).press('Enter');
  await expect(page.getByTestId('command-note')).toContainText('There is no /nope command here');

  // "//" sends the text as a message.
  await composer(page).fill('//etc/hosts dosyası');
  await composer(page).press('Enter');
  await expect(page.getByRole('log').getByText('/etc/hosts dosyası')).toBeVisible();
  expect(runs).toHaveLength(3);
});

test('a message can be sent later and cancelled', async ({ page }, testInfo) => {
  await mockApi(page);
  await mockCommands(page);
  await page.goto('/');
  await composer(page).fill('Haftalık özet');
  await page.getByRole('button', { name: 'Send later' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send later' });
  await expect(dialog.getByText('Nothing scheduled.')).toBeVisible();
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: /Tomorrow morning/ }).click();
  await expect(page.getByText(/^Scheduled for /)).toBeVisible();
  await expect(composer(page)).toHaveValue('');

  await page.getByRole('button', { name: 'Send later' }).click();
  await expect(dialog.getByTestId('scheduled')).toContainText('Haftalık özet');
  await expect(dialog.getByTestId('scheduled')).toContainText('#General');
  await dialog.getByRole('button', { name: /Cancel the message for/ }).click();
  await expect(dialog.getByText('Nothing scheduled.')).toBeVisible();
});
