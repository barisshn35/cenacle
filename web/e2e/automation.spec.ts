// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  DEFAULT_WS,
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  SESSION,
} from './helpers';

const FORM = {
  id: '01a15e50-f0f0-7000-8000-000000000001',
  name: 'Time off',
  description: 'Ask for days off',
  updated_at: '2026-10-22T10:00:00Z',
  fields: [
    { id: 'reason', label: 'Reason', kind: 'text', required: true },
    { id: 'kind', label: 'Kind', kind: 'select', required: false, options: ['Vacation', 'Sick'] },
    { id: 'agree', label: 'I told my team', kind: 'checkbox', required: true },
  ],
};

test('a form is filled in from the composer; its answers show in the channel', async ({
  page,
}, testInfo) => {
  const api = await mockApi(page, { messages: [mockMessage(1, 'Hello')] });
  await page.route(`**/api/channels/${GENERAL.id}/shortcuts`, (route) =>
    route.fulfill({
      json: {
        workflows: [
          {
            id: '01a15e50-f0f0-7000-8000-0000000000aa',
            name: 'Deploy',
            description: 'Ask to deploy',
          },
        ],
        forms: [FORM],
      },
    }),
  );
  let sent: unknown;
  await page.route(`**/api/forms/${FORM.id}/submissions`, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        ...mockMessage(2, ''),
        author: { id: SESSION.user.id, display_name: SESSION.user.display_name },
        submission: {
          id: '01a15e50-f0f0-7000-8000-0000000000bb',
          form_id: FORM.id,
          form_name: 'Time off',
          user: { id: SESSION.user.id, display_name: SESSION.user.display_name },
          answers: [
            { id: 'reason', label: 'Reason', kind: 'text', value: 'Trip' },
            { id: 'kind', label: 'Kind', kind: 'select', value: 'Vacation' },
            { id: 'agree', label: 'I told my team', kind: 'checkbox', value: '✓' },
          ],
          created_at: '2026-10-22T10:00:00Z',
        },
      },
    });
  });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('Hello')).toBeVisible();
  await page.getByRole('button', { name: 'Workflows and forms' }).click();
  const menu = page.getByTestId('shortcuts');
  await expect(menu.getByRole('button', { name: /Deploy/ })).toBeVisible();
  await menu.getByRole('button', { name: 'Time off' }).click();
  const dialog = page.getByRole('dialog', { name: 'Time off' });
  await dialog.getByLabel(/Reason/).fill('Trip');
  await dialog.getByLabel('Kind').selectOption('Vacation');
  await dialog.getByRole('checkbox', { name: /I told my team/ }).check();
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toEqual({
    channel_id: GENERAL.id,
    values: { reason: 'Trip', kind: 'Vacation', agree: 'true' },
  });
  const card = page.getByTestId('submission');
  await expect(card).toContainText('Time off');
  await expect(card).toContainText('Trip');
  void api;
});

test('a manual workflow opens its first form at once', async ({ page }) => {
  await mockApi(page, { messages: [mockMessage(1, 'Hello')] });
  const workflow = {
    id: '01a15e50-f0f0-7000-8000-0000000000aa',
    name: 'Request time off',
    description: '',
  };
  await page.route(`**/api/channels/${GENERAL.id}/shortcuts`, (route) =>
    route.fulfill({ json: { workflows: [workflow], forms: [] } }),
  );
  const task = {
    id: '01a15e50-f0f0-7000-8000-0000000000cc',
    kind: 'form',
    title: 'Time off',
    status: 'open',
    assignees: [SESSION.user.id],
    comment: '',
    created_at: '2026-10-22T10:00:00Z',
    form: FORM,
  };
  await page.route(`**/api/workflows/${workflow.id}/runs`, (route) =>
    route.fulfill({
      status: 201,
      json: {
        run: {
          id: 'r1',
          workflow_name: workflow.name,
          status: 'waiting',
          step: 1,
          steps: 3,
          error: '',
          created_at: '2026-10-22T10:00:00Z',
        },
        task,
      },
    }),
  );
  let values: unknown;
  await page.route(`**/api/tasks/${task.id}/submit`, (route) => {
    values = (route.request().postDataJSON() as { values: unknown }).values;
    return route.fulfill({ json: { ...task, status: 'done' } });
  });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('Hello')).toBeVisible();
  await page.getByRole('button', { name: 'Workflows and forms' }).click();
  await page
    .getByTestId('shortcuts')
    .getByRole('button', { name: /Request time off/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Time off' });
  await dialog.getByLabel(/Reason/).fill('Wedding');
  await dialog.getByRole('checkbox', { name: /I told my team/ }).check();
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Answers sent.')).toBeVisible();
  expect(values).toEqual({ reason: 'Wedding', agree: 'true' });
});

test('an approver decides on an approval card', async ({ page }) => {
  const card = {
    ...mockMessage(1, '', 'Cenacle'),
    task: {
      id: '01a15e50-f0f0-7000-8000-0000000000dd',
      kind: 'approval',
      title: 'Approve 3 days off for Ayşe?',
      status: 'open',
      assignees: [SESSION.user.id],
      comment: '',
      created_at: '2026-10-22T10:00:00Z',
    },
  };
  const api = await mockApi(page, { messages: [card, mockMessage(2, 'later')] });
  let decision: unknown;
  await page.route(`**/api/tasks/${card.task.id}/decide`, (route) => {
    decision = route.request().postDataJSON();
    return route.fulfill({ json: { ...card.task, status: 'approved' } });
  });
  await page.goto(`/c/${GENERAL.id}`);
  const task = page.getByTestId('task');
  await expect(task).toContainText('Approve 3 days off for Ayşe?');
  await expect(task).toContainText('Waiting for a decision');
  await expectNoAxeViolations(page, '[data-testid="task"]');
  await task.getByPlaceholder('Comment (optional)').fill('Enjoy');
  await task.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => decision).toEqual({ approve: true, comment: 'Enjoy' });
  // The decision arrives for everyone as the card's update.
  api.emit('message.updated', {
    ...card,
    task: {
      ...card.task,
      status: 'approved',
      done_by: { id: SESSION.user.id, display_name: SESSION.user.display_name },
    },
  });
  await expect(task).toHaveAttribute('data-status', 'approved');
  await expect(task).toContainText(`Approved by ${SESSION.user.display_name}`);
  await expect(task.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('admins build a webhook workflow and see its address once', async ({ page }, testInfo) => {
  await mockApi(page, { messages: [], admin: true });
  let created: unknown;
  await page.route(`**/api/workspaces/${DEFAULT_WS}/workflows`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { workflows: [] } });
    created = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        id: '01a15e50-f0f0-7000-8000-0000000000ee',
        name: 'Alerts',
        description: '',
        enabled: true,
        trigger: { kind: 'webhook', channel_id: GENERAL.id },
        steps: [{ id: 'step_1', kind: 'message', text: '{{webhook.service}} is down' }],
        updated_at: '2026-10-22T10:00:00Z',
        webhook_url: 'https://chat.example.com/api/workflow-hooks/cnw_secret',
        secret: 'cns_abc',
      },
    });
  });
  await page.goto('/workflows');
  await page.getByRole('button', { name: 'New workflow' }).click();
  const editor = page.getByRole('dialog', { name: 'New workflow' });
  await editor.getByLabel('Name', { exact: true }).fill('Alerts');
  await editor.getByLabel('Trigger').selectOption('webhook');
  await editor.getByLabel('Channel (optional)').selectOption(GENERAL.id);
  await editor.getByLabel('Message').fill('{{webhook.service}} is down');
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await editor.getByRole('button', { name: 'Save' }).click();
  expect(created).toMatchObject({
    name: 'Alerts',
    enabled: true,
    trigger: { kind: 'webhook', channel_id: GENERAL.id },
    steps: [{ kind: 'message', text: '{{webhook.service}} is down' }],
  });
  const secrets = page.getByTestId('workflow-secrets');
  await expect(secrets).toContainText('cnw_secret');
  await expect(secrets).toContainText('cns_abc');
});
