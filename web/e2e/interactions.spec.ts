// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, GENERAL, mockApi, mockMessage } from './helpers';

const BOT = { id: '01a15e50-b0b0-7000-8000-000000000001', display_name: 'Deploy', is_bot: true };

test('a bot card’s buttons and menus ask the bot, which can open a dialog', async ({ page }) => {
  const card = {
    ...mockMessage(1, ''),
    author: BOT,
    attachments: [
      {
        title: 'Release 1.4',
        actions: [
          { id: 'approve', type: 'button', text: 'Approve', style: 'primary' },
          {
            id: 'env',
            type: 'select',
            text: 'Environment',
            options: [{ text: 'Production', value: 'prod' }],
          },
        ],
      },
    ],
  };
  await mockApi(page, { messages: [card] });
  const pressed: unknown[] = [];
  await page.route(/\/messages\/[0-9a-f-]{36}\/actions$/, (route) => {
    pressed.push(route.request().postDataJSON());
    const body = route.request().postDataJSON() as { action_id: string };
    return route.fulfill({
      json:
        body.action_id === 'env'
          ? { text: 'Production chosen.' }
          : {
              dialog: {
                id: '01a15e50-d1a1-7000-8000-000000000001',
                title: 'Deploy 1.4',
                submit_label: 'Deploy',
                elements: [
                  { name: 'reason', label: 'Reason', type: 'text' },
                  { name: 'notify', label: 'Tell the team', type: 'checkbox' },
                ],
              },
            },
    });
  });
  let submitted: { values: Record<string, string> } | undefined;
  await page.route(/\/api\/dialogs\/[0-9a-f-]{36}$/, (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    return route.fulfill({
      json: submitted!.values.reason ? { text: 'Deploying.' } : { errors: { reason: 'Required.' } },
    });
  });
  await page.goto(`/c/${GENERAL.id}`);
  const actions = page.getByTestId('card-actions');
  await actions.getByLabel('Environment').selectOption('prod');
  await expect(page.getByText('Production chosen.')).toBeVisible();

  await actions.getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog', { name: 'Deploy 1.4' });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Deploy' }).click();
  await expect(dialog.getByText('Required.')).toBeVisible();
  await dialog.getByLabel('Reason').fill('hotfix');
  await dialog.getByLabel('Tell the team').check();
  await dialog.getByRole('button', { name: 'Deploy' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Deploying.')).toBeVisible();
  expect(submitted?.values).toEqual({ reason: 'hotfix', notify: 'true' });
  expect(pressed).toEqual([
    { attachment: 0, action_id: 'env', value: 'prod' },
    { attachment: 0, action_id: 'approve' },
  ]);
});
