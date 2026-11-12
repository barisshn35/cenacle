// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  DEFAULT_WS,
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  showActions,
} from './helpers';

const CLASSIFIED = {
  id: '01a16100-0000-7000-8000-0000000000a1',
  name: 'Internal',
  description: 'For employees only',
  color: 'info',
};

test('spillage is reported only where the workspace classifies channels', async ({ page }) => {
  await mockApi(page, { messages: [mockMessage(1, 'parola: hunter2')] });
  await page.goto(`/c/${GENERAL.id}`);
  const msg = page.getByTestId('message').filter({ hasText: 'parola: hunter2' });
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  // Without classifications only reporting the person is left, on the first level.
  await expect(page.getByRole('menuitem', { name: 'Report', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Report spillage' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Report a problem' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Mark as unread' })).toContainText('Alt+Click');
  await expectNoAxeViolations(page, '[role="menu"]');
});

test('someone reports spillage and a reviewer removes it everywhere', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'the workspace menu is in the drawer on phones');
  await mockApi(page, { admin: true, messages: [mockMessage(1, 'parola: hunter2')] });
  await page.route(`**/api/workspaces/${DEFAULT_WS}/classifications`, (route) =>
    route.fulfill({ json: { classifications: [CLASSIFIED], default_id: null } }),
  );
  const reports: Record<string, unknown>[] = [];
  let reported: unknown;
  await page.route(
    /\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/spillage$/,
    (route) => {
      reported = route.request().postDataJSON();
      const r = {
        id: '01a16500-0000-7000-8000-0000000000a1',
        channel_id: GENERAL.id,
        channel_name: 'General',
        message_id: mockMessage(1, '').id,
        author_name: 'Ayşe Yılmaz',
        body: 'parola: hunter2',
        reason: (reported as { reason: string }).reason,
        status: 'open',
        reported_by: 'Yönetici',
        created_at: '2026-10-24T10:00:00Z',
      };
      reports.push(r);
      return route.fulfill({ status: 201, json: r });
    },
  );
  await page.route(`**/api/workspaces/${DEFAULT_WS}/spillage`, (route) =>
    route.fulfill({ json: { reports } }),
  );
  let decided: unknown;
  await page.route('**/api/spillage/*/decision', (route) => {
    decided = route.request().postDataJSON();
    Object.assign(reports[0]!, {
      status: 'removed',
      body: undefined,
      decided_by: 'Yönetici',
      decided_at: '2026-10-24T10:05:00Z',
    });
    return route.fulfill({ json: reports[0] });
  });
  await page.goto(`/c/${GENERAL.id}`);
  const msg = page.getByTestId('message').filter({ hasText: 'parola: hunter2' });
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  // Reporting someone and reporting spillage share a submenu.
  await page.getByRole('menuitem', { name: 'Report a problem' }).click();
  await page.getByRole('menuitem', { name: 'Report spillage' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report spillage' });
  await dialog.getByLabel('What is wrong').fill('Bir parola paylaşıldı.');
  await dialog.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByText('Reported. The reviewers will decide.')).toBeVisible();
  expect(reported).toEqual({ reason: 'Bir parola paylaşıldı.' });

  // The owner reviews when nobody else was chosen.
  await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
  await page.getByRole('menuitem', { name: 'Spillage reports' }).click();
  const queue = page.getByRole('dialog', { name: 'Spillage reports' });
  await expect(queue.getByTestId('spillage-open')).toContainText('Bir parola paylaşıldı.');
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await queue.getByRole('button', { name: 'Remove everywhere' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove everywhere' }).click();
  await expect(queue.getByTestId('spillage-decided')).toContainText('Removed');
  expect(decided).toEqual({ decision: 'remove' });
});

test('people download their data and administrators erase a person', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Settings opens from the sidebar on wide screens');
  await mockApi(page, { admin: true });
  await page.route('**/api/admin/overview', (route) =>
    route.fulfill({
      json: {
        version: '0.36.0',
        desktop_apps: [],
        counts: {
          users: 2,
          active_users: 1,
          bots: 0,
          workspaces: 1,
          channels: 1,
          messages: 0,
          files: 0,
          file_bytes: 0,
        },
        config: [],
        jobs: [],
        failures: [],
      },
    }),
  );
  const ayse = {
    id: '01a16500-0000-7000-8000-0000000000b1',
    display_name: 'Ayşe Yılmaz',
    email: 'ayse@example.com',
    username: 'ayse',
    is_admin: false,
    guest: false,
    deactivated: false,
    last_seen_at: null,
    created_at: '2026-10-01T09:00:00Z',
    workspaces: 1,
    sessions: 0,
    erased: false,
  };
  await page.route(/\/api\/admin\/users(\?.*)?$/, (route) =>
    route.fulfill({ json: { users: [ayse] } }),
  );
  let erased: unknown;
  await page.route(`**/api/admin/users/${ayse.id}/erase`, (route) => {
    erased = route.request().postDataJSON();
    return route.fulfill({ json: { messages_erased: 12, messages_held: 3 } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('link', { name: 'Download your data' })).toHaveAttribute(
    'href',
    '/api/me/export',
  );
  // Where the server's source code and the licenses of what it ships are (AGPL-3.0 section 13).
  await expect(settings.getByRole('link', { name: /^Source code/ })).toHaveAttribute(
    'href',
    'https://github.com/Cenacle-TR/cenacle',
  );
  await expect(settings.getByRole('link', { name: /^Open-source licenses/ })).toHaveAttribute(
    'href',
    '/third-party-notices.txt',
  );

  await page.getByRole('button', { name: 'System console' }).click();
  const console = page.getByRole('dialog', { name: 'System console' });
  await console.getByRole('tab', { name: /People/ }).click();
  await expect(
    console.getByRole('link', { name: 'Download the data of Ayşe Yılmaz' }),
  ).toHaveAttribute('href', `/api/admin/users/${ayse.id}/export`);
  await console.getByRole('button', { name: 'Erase Ayşe Yılmaz' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Erase Ayşe Yılmaz?' });
  await expect(confirm.getByRole('button', { name: 'Erase person' })).toBeDisabled();
  await confirm.getByRole('textbox').fill('Ayşe Yılmaz');
  await confirm.getByRole('button', { name: 'Erase person' }).click();
  await expect(page.getByText('Erased: 12 messages deleted, 3 kept by legal holds.')).toBeVisible();
  expect(erased).toEqual({ confirm: 'Ayşe Yılmaz' });
});

test('owners download an archive and turn on daily exports', async ({ page }, testInfo) => {
  await mockApi(page, { messages: [], admin: true });
  await page.route(`**/api/workspaces/${DEFAULT_WS}/compliance`, (route) =>
    route.fulfill({
      json: {
        retention_days: null,
        default_classification: null,
        classifications: [],
        attributes: [],
      },
    }),
  );
  await page.route(`**/api/workspaces/${DEFAULT_WS}/legal-holds`, (route) =>
    route.fulfill({ json: { holds: [] } }),
  );
  let schedule = { format: 'off', available: true, exports: [] as unknown[] };
  await page.route(`**/api/workspaces/${DEFAULT_WS}/archive-schedule`, (route) => {
    if (route.request().method() === 'PUT') {
      const { format } = route.request().postDataJSON() as { format: string };
      schedule = {
        ...schedule,
        format,
        exports: [
          {
            id: '01a16500-0000-7000-8000-0000000000c1',
            format: 'actiance',
            day: '2026-10-23',
            size: 2048,
            messages: 7,
            created_at: '2026-10-24T00:10:00Z',
          },
        ],
      };
    }
    return route.fulfill({ json: schedule });
  });
  let asked = '';
  await page.route(`**/api/workspaces/${DEFAULT_WS}/archive?*`, (route) => {
    asked = route.request().url();
    return route.fulfill({ contentType: 'text/csv', body: 'message_id\n' });
  });
  await page.goto('/compliance');
  const archive = page.getByTestId('archive');
  await archive.getByLabel('From').fill('2026-10-01');
  await archive.getByLabel('To').fill('2026-10-02');
  await archive.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => asked).toContain('format=csv');
  const url = new URL(asked);
  expect(url.searchParams.get('since')).toBe('2026-10-01T00:00:00Z');
  expect(url.searchParams.get('until')).toBe('2026-10-03T00:00:00.000Z');
  await archive.getByLabel('Every day').selectOption('actiance');
  await expect(archive.getByTestId('archive-exports')).toContainText('7 messages');
  await page.mouse.move(0, 0);
  await expectTargetSizes(page, testInfo, '[data-testid="archive"]');
  await expectNoAxeViolations(page, '[data-testid="archive"]');
});
