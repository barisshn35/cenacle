// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  FORUM,
  GENERAL,
  instance,
  mockApi,
  mockMessage,
  SESSION,
  showActions,
  composerTool,
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
  await composerTool(page, 'Poll');
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
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Report', exact: true }).click();
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
  await event.getByRole('button', { name: 'Going', exact: true }).click();
  await expect(event.getByRole('button', { name: 'Going', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Who answered what, in groups.
  await event.getByRole('button', { name: /Who answered for Sprint review/ }).click();
  const answers = page.getByTestId('event-answers');
  await expect(answers.getByRole('heading', { name: 'Going (1)' })).toBeVisible();
  await expect(answers).toContainText(SESSION.user.display_name);
  await expect(answers.getByRole('heading', { name: 'Maybe (0)' })).toBeVisible();
  await expect(answers.getByRole('heading', { name: "Can't go (0)" })).toBeVisible();
  await page.keyboard.press('Escape');
  await event.getByRole('button', { name: "Can't go", exact: true }).click();
  await expect(event).toContainText("0 going · 1 can't go");
  await expectNoAxeViolations(page, 'main');
});

const lateEvent = (status: 'going' | 'maybe' | 'declined') => {
  const start = new Date();
  start.setHours(23, 50, 0, 0);
  return {
    id: '01a15e50-eeee-7000-8000-000000000099',
    workspace_id: GENERAL.workspace_id,
    channel_id: null,
    title: 'Gece bakımı',
    description: '',
    location: 'Sunucu odası',
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 15 * 60_000).toISOString(),
    created_by: null,
    canceled: false,
    going: [],
    maybe: 0,
    maybe_people: [],
    declined_people: [],
    me: status,
    can_edit: true,
  };
};
// Each answer button lies inside its cell (one ran over the next cell).
async function answersFit(page: Page, names: string[]) {
  const event = page.getByTestId('event');
  const group = (await event.getByRole('group').boundingBox())!;
  // The event's own menu, next to the answers (its creator or an admin sees it).
  const more = event.getByRole('button', { name: /^More for | için diğer$/ });
  const menu = (await more.count()) ? await more.boundingBox() : null;
  for (const name of names) {
    const box = (await event.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(group.x + group.width + 0.5);
    if (menu) expect(box.x + box.width).toBeLessThanOrEqual(menu.x);
  }
}

test('an event past midnight says its end is the next day; the answers fit', async ({ page }) => {
  const api = await mockApi(page, { messages: [] });
  api.events.push(lateEvent('declined'));
  await page.goto('/events');
  const event = page.getByTestId('event');
  await expect(event).toContainText('until 12:05 AM next day');
  await expect(event).not.toContainText('–12:05');
  await answersFit(page, ['Going', 'Maybe', "Can't go"]);
});

test.describe('in Turkish', () => {
  test.use({ locale: 'tr-TR' });

  test('the end past midnight and the answers fit', async ({ page }) => {
    const api = await mockApi(page, { messages: [] });
    api.events.push(lateEvent('declined'));
    await page.goto('/events');
    const event = page.getByTestId('event');
    await expect(event).toContainText('bitiş ertesi gün 00:05');
    await answersFit(page, ['Katılıyorum', 'Belki', 'Katılamıyorum']);
  });
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
