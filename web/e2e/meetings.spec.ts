// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, type Page } from '@playwright/test';
import { GENERAL, PEOPLE, SESSION, mockApi, expectNoAxeViolations } from './helpers';

const AYSE = PEOPLE[1]!;
const MEETING_ID = '019b0000-0000-7000-8000-0000000000a1';
const EVENT_ID = '019b0000-0000-7000-8000-0000000000e1';

/** An occurrence starting `inMinutes` from now, 30 minutes long. */
function soon(inMinutes: number) {
  const start = new Date(Date.now() + inMinutes * 60_000);
  start.setSeconds(0, 0);
  return { start, end: new Date(start.getTime() + 30 * 60_000) };
}

function meeting(start: Date, end: Date, over: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    workspace_id: GENERAL.workspace_id,
    channel_id: GENERAL.id,
    organizer_id: AYSE.id,
    title: 'Roadmap review',
    agenda: '1. Results\n2. Plans',
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    timezone: 'Europe/Istanbul',
    rrule: 'FREQ=WEEKLY;COUNT=4',
    exdates: [],
    cancelled: false,
    my_response: 'pending',
    can_edit: false,
    invitees: [
      { user_id: AYSE.id, display_name: AYSE.display_name, response: 'yes', organizer: true },
      {
        user_id: SESSION.user.id,
        display_name: SESSION.user.display_name,
        response: 'pending',
        organizer: false,
      },
    ],
    ...over,
  };
}

async function calendar(page: Page, start: Date, end: Date) {
  await page.route(/\/api\/calendar\?/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            kind: 'meeting',
            id: MEETING_ID,
            workspace_id: GENERAL.workspace_id,
            channel_id: GENERAL.id,
            title: 'Roadmap review',
            starts_at: start.toISOString(),
            ends_at: end.toISOString(),
            response: 'pending',
            recurring: true,
          },
          {
            kind: 'event',
            id: EVENT_ID,
            workspace_id: GENERAL.workspace_id,
            channel_id: null,
            title: 'Team breakfast',
            starts_at: new Date(start.getTime() + 2 * 3600_000).toISOString(),
            ends_at: new Date(start.getTime() + 3 * 3600_000).toISOString(),
            response: 'going',
            recurring: false,
          },
        ],
      },
    }),
  );
}

test('the calendar shows meetings in each of its four views, and a meeting is answered', async ({
  page,
  isMobile,
}) => {
  await mockApi(page);
  const { start, end } = soon(90);
  await calendar(page, start, end);
  let answered: unknown = null;
  await page.route(`**/api/meetings/${MEETING_ID}`, (route) =>
    route.fulfill({ json: meeting(start, end, { my_response: answered ? 'maybe' : 'pending' }) }),
  );
  await page.route(`**/api/meetings/${MEETING_ID}/response`, (route) => {
    answered = route.request().postDataJSON();
    return route.fulfill({ status: 204 });
  });
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();

  // Phones show the agenda; the other views need the width.
  const views = isMobile
    ? [['Agenda', 'calendar-agenda']]
    : [
        ['Board', 'calendar-board'],
        ['Planner', 'calendar-planner'],
        ['Today & month', 'calendar-today'],
        ['Agenda', 'calendar-agenda'],
      ];
  for (const [view, id] of views) {
    if (!isMobile) await page.getByRole('button', { name: view, exact: true }).click();
    const shown = page.getByTestId(id!);
    await expect(shown).toBeVisible();
    // The month shows days, not titles: the meeting's day opens beside it.
    if (id === 'calendar-today') {
      const day = new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(start);
      await shown.getByRole('button', { name: new RegExp(`${day}$`) }).click();
    } else {
      await expect(
        shown.getByTestId('calendar-item').filter({ hasText: 'Team breakfast' }).first(),
      ).toBeVisible();
    }
    await expect(
      shown.getByTestId('calendar-item').filter({ hasText: 'Roadmap review' }).first(),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  }
  // Not answered is said in words, not by its outline alone; the next meeting leads.
  await expect(page.getByTestId('calendar-agenda')).toContainText('Not answered');
  await expect(page.getByRole('region', { name: 'Next' })).toContainText('Roadmap review');
  await expectNoAxeViolations(page);

  await page.getByTestId('calendar-item').filter({ hasText: 'Roadmap review' }).click();
  const details = page.getByTestId('meeting');
  await expect(details.getByRole('heading', { name: 'Roadmap review' })).toBeVisible();
  await expect(details).toContainText('4 times');
  // An hour and a half before: Join is not open yet, and says when it opens.
  await expect(details.getByRole('button', { name: 'Join' })).toBeDisabled();
  await expect(details).toContainText('Join opens 5 minutes before the meeting.');
  await details.getByRole('button', { name: 'Maybe' }).click();
  await expect.poll(() => answered).toEqual({ response: 'maybe' });
  await expect(details.getByRole('button', { name: 'Maybe' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectNoAxeViolations(page);
});

test('a meeting about to start can be joined from its link', async ({ page }) => {
  await mockApi(page);
  const { start, end } = soon(3);
  await page.route(`**/api/meetings/${MEETING_ID}`, (route) =>
    route.fulfill({ json: meeting(start, end, { rrule: '' }) }),
  );
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({
      json: {
        available: true,
        enabled: true,
        guest_start: false,
        max_participants: 8,
        max_bitrate: 2500000,
      },
    }),
  );
  // E-mails link to /meetings/<id>.
  await page.goto(`/meetings/${MEETING_ID}`);
  await expect(page).toHaveURL(new RegExp(`/calendar\\?meeting=${MEETING_ID}`));
  const details = page.getByTestId('meeting');
  await expect(details.getByRole('button', { name: 'Join' })).toBeEnabled();
  await details.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\/calendar$/);
});

test('planning a repeating meeting with people sends one rule and the invitees', async ({
  page,
}) => {
  await mockApi(page);
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/meetings', (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    const s = new Date(sent.starts_at as string);
    const e = new Date(sent.ends_at as string);
    return route.fulfill({
      status: 201,
      json: meeting(s, e, { my_response: 'yes', can_edit: true }),
    });
  });
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'New meeting' }).click();
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await dialog.getByLabel('Title').fill('Weekly sync');
  await dialog.getByLabel('Date').fill('2026-12-01');
  await dialog.getByLabel('Starts').fill('14:00');
  await dialog.getByLabel('Ends').fill('14:45');
  await dialog.getByLabel('Repeat').selectOption('weekly');
  await dialog.getByRole('button', { name: 'Thursday' }).click();
  await dialog.getByLabel('After', { exact: true }).check();
  await dialog.getByLabel('How many times').fill('6');
  await dialog.getByLabel('Find people').fill(AYSE.display_name.split(' ')[0]!);
  await dialog.getByRole('button', { name: `Invite ${AYSE.display_name}` }).click();
  await expect(dialog.getByRole('button', { name: `Remove ${AYSE.display_name}` })).toBeVisible();
  await dialog.getByLabel('Agenda').fill('Status and next steps');
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Plan meeting' }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toMatchObject({
    title: 'Weekly sync',
    agenda: 'Status and next steps',
    channel_id: null,
    user_ids: [AYSE.id],
    rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6',
  });
  const s = new Date((sent as unknown as { starts_at: string }).starts_at);
  const e = new Date((sent as unknown as { ends_at: string }).ends_at);
  expect([s.getHours(), s.getMinutes(), (e.getTime() - s.getTime()) / 60_000]).toEqual([14, 0, 45]);
});

test('a reminder says the meeting starts soon and opens it', async ({ page }) => {
  const api = await mockApi(page);
  const { start, end } = soon(4);
  await page.route(`**/api/meetings/${MEETING_ID}`, (route) =>
    route.fulfill({ json: meeting(start, end) }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  api.emit('meeting.reminder', {
    to: [SESSION.user.id],
    meeting_id: MEETING_ID,
    channel_id: GENERAL.id,
    title: 'Roadmap review',
    starts_at: start.toISOString(),
  });
  const toast = page.getByText('Roadmap review starts soon');
  await expect(toast).toBeVisible();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(
    page.getByTestId('meeting').getByRole('heading', { name: 'Roadmap review' }),
  ).toBeVisible();
});

test('a calendar subscription address is made, shown once and copied', async ({
  page,
  context,
  browserName,
}) => {
  // WebKit lets a click write to the clipboard and knows no such permissions.
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await mockApi(page);
  const url = 'http://localhost/api/calendar-feeds/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  await page.route('**/api/me/calendar-feed', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: { url } })
      : route.fulfill({ json: { exists: false, created_at: null } }),
  );
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Subscribe' }).click();
  const dialog = page.getByRole('dialog', { name: 'Subscribe in your calendar' });
  await dialog.getByRole('button', { name: 'Make an address' }).click();
  await expect(dialog.getByLabel('Your private address')).toHaveValue(url);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Address copied')).toBeVisible();
});

test('meeting reminders and e-mails are chosen in the notification settings', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the settings open from the sidebar on phones');
  await mockApi(page);
  let saved: Record<string, unknown> | null = null;
  await page.route('**/api/me/notifications', (route) => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON();
    return route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Notifications' }).click();
  await dialog.getByLabel('Remind me before a meeting').selectOption('5');
  await expect
    .poll(() => (saved as { meetings?: unknown } | null)?.meetings)
    .toMatchObject({
      remind_minutes: 5,
    });
});

test.describe('in Turkish', () => {
  test.use({ locale: 'tr-TR' });
  test('the calendar and its words', async ({ page }) => {
    await mockApi(page);
    const { start, end } = soon(90);
    await calendar(page, start, end);
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: 'Takvim', level: 1 })).toBeVisible();
    await expect(page.getByTestId('calendar-agenda')).toContainText('Yanıt bekliyor');
    await expect(page.getByRole('region', { name: 'Sıradaki' })).toBeVisible();
  });
});

test('the planned meeting is in the channel it was planned from', async ({ page, isMobile }) => {
  test.skip(isMobile, 'on phones meetings are planned from the calendar');
  await mockApi(page);
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({
      json: {
        available: true,
        enabled: true,
        guest_start: false,
        max_participants: 8,
        max_bitrate: 2500000,
      },
    }),
  );
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/meetings', (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      json: meeting(new Date(sent.starts_at as string), new Date(sent.ends_at as string)),
    });
  });
  await page.route(`**/api/channels/${GENERAL.id}/members`, (route) =>
    route.fulfill({
      json: {
        members: [
          { user: PEOPLE[0], role: 'member' },
          { user: AYSE, role: 'member' },
        ],
      },
    }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Plan a meeting' }).click();
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await expect(dialog).toContainText('The call happens in General.');
  await dialog.getByLabel('Title').fill('Retro');
  await dialog.getByRole('button', { name: /Everyone here/ }).click();
  await dialog.getByRole('button', { name: 'Plan meeting' }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toMatchObject({ title: 'Retro', channel_id: GENERAL.id, rrule: '' });
  expect((sent as unknown as { user_ids: string[] }).user_ids).toEqual([AYSE.id]);
});
