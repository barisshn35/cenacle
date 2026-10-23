// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  FORUM,
  GENERAL,
  instance,
  mockApi,
  mockMessage,
  SESSION,
} from './helpers';

test('the terms of service come first; the banner shows above the app', async ({ page }) => {
  await mockApi(page, { messages: [] });
  instance.terms = {
    id: '01a15e50-7777-7000-8000-000000000001',
    text: '**Be kind.**',
    created_at: '2026-10-22T10:00:00Z',
  };
  instance.accepted = false;
  instance.banner = {
    text: 'Maintenance at 22:00',
    level: 'warning',
    dismissible: true,
    updated_at: '2026-10-22T10:00:00Z',
  };
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByRole('heading', { name: 'Terms of service' })).toBeVisible();
  await expect(page.getByTestId('terms-text')).toContainText('Be kind.');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'I accept' }).click();
  await expect(page.getByRole('log', { name: /Messages in/ })).toBeVisible();
  const banner = page.getByTestId('instance-banner');
  await expect(banner).toContainText('Maintenance at 22:00');
  await banner.getByRole('button', { name: 'Dismiss the announcement' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('log', { name: /Messages in/ })).toBeVisible();
  await expect(page.getByTestId('instance-banner')).toHaveCount(0);
});

test('a poll is created from the composer and voted in', async ({ page }, testInfo) => {
  const api = await mockApi(page, { messages: [] });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Create poll' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create poll' });
  await dialog.getByLabel('Question').fill('Lunch?');
  await dialog.getByLabel('Option 1').fill('Pizza');
  await dialog.getByLabel('Option 2').fill('Salad');
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Send poll' }).click();
  expect(api.sent.at(-1)).toMatchObject({ body: 'Lunch?', poll: { options: ['Pizza', 'Salad'] } });
  const poll = page.getByTestId('poll');
  await expect(poll).toBeVisible();
  await poll.getByRole('radio', { name: /Pizza/ }).click();
  await expect(poll.getByRole('radio', { name: /Pizza/ })).toHaveAttribute('aria-checked', 'true');
  await expect(poll).toContainText('1 person voted');
});

test('a message is reported to the moderators', async ({ page }) => {
  const api = await mockApi(page, { messages: [mockMessage(1, 'Something rude')] });
  await page.goto(`/c/${GENERAL.id}`);
  const msg = page.getByTestId('message').filter({ hasText: 'Something rude' });
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report message' });
  await dialog.getByLabel('Reason (optional)').fill('Rude');
  await dialog.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByText('Reported to the moderators')).toBeVisible();
  expect(api.reports).toEqual(['Rude']);
});

test('a forum lists posts and starts one with a title and tags', async ({ page, isMobile }) => {
  const api = await mockApi(page, { messages: [], channels: [FORUM] });
  await page.goto(`/c/${FORUM.id}`);
  const forum = page.getByTestId('forum');
  await expect(forum.getByText('No posts yet.', { exact: false })).toBeVisible();
  await forum.getByRole('button', { name: 'New post' }).click();
  const dialog = page.getByRole('dialog', { name: 'New post' });
  await dialog.getByLabel('Title').fill('Dark mode');
  await dialog.getByLabel('Post').fill('Everywhere, please.');
  await dialog.getByRole('button', { name: 'UX' }).click();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  expect(api.sent.at(-1)).toMatchObject({ title: 'Dark mode', tags: ['UX'] });
  await expect(page.getByTestId('thread-panel').getByTestId('post-title')).toHaveText('Dark mode');
  if (isMobile)
    await page.getByTestId('thread-panel').getByRole('button', { name: 'Close thread' }).click();
  await expect(forum.getByTestId('forum-post')).toContainText('Dark mode');
});

test('events are planned and answered', async ({ page }) => {
  await mockApi(page, { messages: [] });
  await page.goto('/events');
  await page.getByRole('button', { name: 'New event' }).click();
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await dialog.getByLabel('Title').fill('Sprint review');
  await dialog.getByLabel('Location').fill('Room 4');
  await dialog.getByRole('button', { name: 'Save event' }).click();
  const event = page.getByTestId('event');
  await expect(event).toContainText('Sprint review');
  await event.getByRole('button', { name: 'Going' }).click();
  await expect(event.getByRole('button', { name: 'Going' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectNoAxeViolations(page, 'main');
});

test.describe('administration', () => {
  test.skip(({ isMobile }) => isMobile, 'the workspace menu is in the desktop sidebar');

  test('admins add AutoMod rules and write playbooks', async ({ page }) => {
    const api = await mockApi(page, { messages: [], admin: true });
    await page.goto(`/c/${GENERAL.id}`);
    await page
      .getByRole('button', { name: /Cenacle workspace menu|Cenacle/ })
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Moderation' }).click();
    const dialog = page.getByTestId('moderation');
    await expect(dialog.getByText('No open reports.')).toBeVisible();
    await dialog.getByRole('tab', { name: 'AutoMod' }).click();
    await dialog.getByRole('button', { name: 'Add rule' }).click();
    const form = dialog.getByTestId('automod-form');
    await form.getByLabel('Name').fill('No spam');
    await form.getByLabel('Words').fill('spam*');
    await form.getByRole('button', { name: 'Save rule' }).click();
    await expect(dialog.getByTestId('automod-rule')).toContainText('No spam');
    expect(api.automod[0]).toMatchObject({ name: 'No spam', kind: 'keywords', words: ['spam*'] });
    await page.keyboard.press('Escape');

    await page.goto('/playbooks');
    await page.getByRole('button', { name: 'New playbook' }).click();
    const editor = page.getByRole('dialog', { name: 'New playbook' });
    await editor.getByLabel('Name').fill('Incident');
    await editor.getByLabel('Title of checklist 1').fill('Triage');
    await editor.getByLabel('Items of checklist 1').fill('Open a channel\nPage on-call');
    await editor.getByRole('button', { name: 'Save playbook' }).click();
    await expect(page.getByTestId('playbook')).toContainText('Incident');
    expect(api.playbooks[0]).toMatchObject({
      name: 'Incident',
      checklists: [
        { title: 'Triage', items: [{ title: 'Open a channel' }, { title: 'Page on-call' }] },
      ],
    });
  });

  test('playbooks list the runs in progress', async ({ page }) => {
    const api = await mockApi(page, { messages: [], admin: true });
    api.playbooks.push({
      id: '01a15e50-bbbb-7000-8000-000000000001',
      name: 'Incident response',
      description: '',
      checklists: [],
      updated_at: new Date().toISOString(),
      runs_active: 1,
    });
    await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/runs$/, (route) =>
      route.fulfill({
        json: {
          runs: [
            {
              id: '01a15e50-cccc-7000-8000-000000000001',
              playbook_id: '01a15e50-bbbb-7000-8000-000000000001',
              channel_id: GENERAL.id,
              name: 'Login slow for LDAP users',
              owner: { id: SESSION.user.id, display_name: SESSION.user.display_name },
              status: 'active',
              checklists: [
                {
                  title: 'Triage',
                  items: [
                    {
                      title: 'a',
                      description: '',
                      done_at: new Date().toISOString(),
                      done_by: null,
                      skipped: false,
                      assignee_id: null,
                    },
                    {
                      title: 'b',
                      description: '',
                      done_at: null,
                      done_by: null,
                      skipped: false,
                      assignee_id: null,
                    },
                  ],
                },
              ],
              created_at: new Date().toISOString(),
              finished_at: null,
            },
          ],
        },
      }),
    );
    await page.goto('/playbooks');
    const run = page.getByTestId('run');
    await expect(run).toContainText('Login slow for LDAP users');
    await expect(run).toContainText('Incident response');
    await expect(run).toContainText('1 of 2');
    await run.getByRole('button', { name: /^Open/ }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${GENERAL.id}`));
  });
});
