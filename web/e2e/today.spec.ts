// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  DEFAULT_WS,
  directWith,
  expectNoAxeViolations,
  expectTargetSizes,
  mockApi,
  mockMessage,
  PEOPLE,
  RANDOM,
  SESSION,
} from './helpers';

const MERT = PEOPLE[2]!;

test('Today gathers mentions, direct messages, the day’s events, answers and reminders', async ({
  page,
}, testInfo) => {
  const dm = directWith(MERT, { unread_count: 2 });
  const api = await mockApi(page, {
    channels: [dm],
    general: { unread_count: 5, mention_count: 1 },
  });
  // Midday, so that "in an hour" is still today whenever the test runs.
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  await page.clock.install({ time: noon });
  const inAnHour = new Date(noon.getTime() + 3_600_000);
  api.events.push({
    id: '01a15e50-eeee-7000-8000-000000000099',
    workspace_id: DEFAULT_WS,
    channel_id: null,
    title: 'Release review',
    description: '',
    location: '',
    starts_at: inAnHour.toISOString(),
    ends_at: new Date(inAnHour.getTime() + 1_800_000).toISOString(),
    created_by: { id: SESSION.user.id, display_name: SESSION.user.display_name },
    canceled: false,
    going: [],
    maybe: 0,
    maybe_people: [],
    declined_people: [],
    me: 'going',
    can_edit: false,
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/tasks$/, (route) =>
    route.fulfill({
      json: {
        tasks: [
          {
            id: '01a15e50-7777-7000-8000-000000000001',
            kind: 'approval',
            title: 'Holiday request',
            status: 'open',
            assignees: [],
            comment: '',
            created_at: noon.toISOString(),
          },
        ],
      },
    }),
  );
  await page.route('**/api/me/saved', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            message: mockMessage(4, 'Send the contract'),
            channel: { id: RANDOM.id, name: 'Random', kind: 'standard', workspace_id: DEFAULT_WS },
            saved_at: new Date(noon.getTime() - 86_400_000).toISOString(),
            remind_at: new Date(noon.getTime() - 60_000).toISOString(),
            done_at: null,
          },
        ],
      },
    }),
  );
  await page.goto('/today');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');

  // Mentions lead, then direct messages.
  const needs = page.getByTestId('today-needs').getByRole('listitem');
  await expect(needs).toHaveCount(2);
  await expect(needs.nth(0)).toContainText('General');
  await expect(needs.nth(0)).toContainText('1 mention');
  await expect(needs.nth(1)).toContainText('Mert Kaya');
  await expect(needs.nth(1)).toContainText('2 unread');
  await expect(page.getByTestId('today-events')).toContainText('Release review');
  await expect(page.getByTestId('today-events')).toContainText('Going');
  await expect(page.getByTestId('today-waiting')).toContainText('Holiday request');
  await expect(page.getByTestId('today-reminders')).toContainText('Send the contract');
  await expectTargetSizes(page, testInfo, '[data-testid="today"]');
  await expectNoAxeViolations(page, '[data-testid="today"]');

  await needs.nth(1).getByRole('link', { name: 'Mert Kaya' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${dm.id}`));
});

test('Today says when nothing waits', async ({ page }) => {
  await mockApi(page, { general: { unread_count: 0 } });
  await page.goto('/today');
  await expect(page.getByTestId('today')).toContainText('Nothing needs you today.');
});
