// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { DEFAULT_WS, expectNoAxeViolations, expectTargetSizes, GENERAL, mockApi } from './helpers';

const CONN = {
  id: '01a16200-0000-7000-8000-0000000000c1',
  name: 'Partner Inc',
  url: 'https://chat.partner.example',
  status: 'active',
  last_error: '',
  last_seen_at: '2026-10-22T10:00:00Z',
  shared: [],
};

test('admins invite a server, see its connection and accept an offered channel', async ({
  page,
}, testInfo) => {
  await mockApi(page, { messages: [], admin: true });
  const state = {
    connections: [CONN],
    offers: [
      {
        id: '01a16200-0000-7000-8000-0000000000d1',
        connection_id: CONN.id,
        connection_name: CONN.name,
        name: 'launch',
        topic: '',
        created_at: '2026-10-22T10:00:00Z',
      },
    ],
  };
  await page.route(`**/api/workspaces/${DEFAULT_WS}/federation`, (route) =>
    route.fulfill({ json: state }),
  );
  await page.route(`**/api/workspaces/${DEFAULT_WS}/federation/invites`, (route) =>
    route.fulfill({
      status: 201,
      json: { code: 'eyJ1IjoiaHR0cHMifQ', expires_at: '2026-10-23T10:00:00Z' },
    }),
  );
  let accepted = false;
  await page.route('**/api/federation/offers/*/accept', (route) => {
    accepted = true;
    state.offers = [];
    return route.fulfill({ status: 201, json: { ...GENERAL } });
  });
  await page.goto('/federation');
  const root = page.getByTestId('federation');
  await expect(root.getByTestId('connection')).toContainText('Partner Inc');
  await expect(root.getByTestId('connection')).toContainText('Connected');
  await expect(root.getByTestId('offer')).toContainText('launch');
  await page.mouse.move(0, 0);
  await expectTargetSizes(page, testInfo, '[data-testid="federation"]');
  await expectNoAxeViolations(page, '[data-testid="federation"]');

  await root.getByLabel('Name of the other server here').fill('Partner Inc');
  await root.getByRole('button', { name: 'Create code' }).click();
  await expect(root.getByTestId('invite-code').getByRole('textbox')).toHaveValue(
    'eyJ1IjoiaHR0cHMifQ',
  );

  await root.getByTestId('offer').getByRole('button', { name: 'Accept' }).click();
  await expect.poll(() => accepted).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/c/${GENERAL.id}`));
});

test('a channel shows the servers it is shared with in its details', async ({ page }) => {
  await mockApi(page, { messages: [], admin: true });
  await page.route(`**/api/channels/${GENERAL.id}/shares`, (route) =>
    route.fulfill({
      json: {
        shares: [{ connection_id: CONN.id, connection_name: 'Partner Inc', status: 'active' }],
      },
    }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  // The details may be open already (wide screens); open them otherwise.
  const toggle = page.getByRole('button', { name: 'Channel details', exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const shares = page.getByTestId('shares');
  await expect(shares).toContainText('Shared with other servers');
  await expect(shares).toContainText('Partner Inc');
  await expectNoAxeViolations(page, '[data-testid="shares"]');
});

test('admins choose what a connection may send and see the federation activity', async ({
  page,
}, testInfo) => {
  await mockApi(page, { messages: [], admin: true });
  const conn = {
    ...CONN,
    policy: {
      receive_messages: true,
      receive_reactions: true,
      receive_edits: true,
      requests_per_minute: 120,
    },
  };
  await page.route(`**/api/workspaces/${DEFAULT_WS}/federation`, (route) =>
    route.fulfill({ json: { connections: [conn], offers: [] } }),
  );
  await page.route(`**/api/workspaces/${DEFAULT_WS}/audit?*`, (route) =>
    route.fulfill({
      json: {
        events: [
          {
            id: '01a16200-0000-7000-8000-0000000000e1',
            at: '2026-10-24T10:00:00Z',
            action: 'federation.refused',
            target_type: 'workspace',
            target_id: DEFAULT_WS,
            detail: { server: 'evil.example', reason: 'policy' },
          },
        ],
        has_more: false,
      },
    }),
  );
  let sent: unknown;
  await page.route(`**/api/federation/connections/${CONN.id}`, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ json: conn });
  });
  await page.goto('/federation');
  const root = page.getByTestId('federation');
  await expect(root.getByTestId('federation-activity')).toContainText(
    'Refused a connection from evil.example',
  );
  await root.getByText('What this connection may send here').click();
  const policy = root.getByTestId('connection-policy');
  await policy.getByLabel('Reactions').uncheck();
  await policy.getByLabel('Requests per minute at most').fill('30');
  await page.mouse.move(0, 0);
  await expectTargetSizes(page, testInfo, '[data-testid="federation"]');
  await expectNoAxeViolations(page, '[data-testid="federation"]');
  await policy.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Connection settings saved.')).toBeVisible();
  expect(sent).toEqual({
    policy: {
      receive_messages: true,
      receive_reactions: false,
      receive_edits: true,
      requests_per_minute: 30,
    },
  });
});
