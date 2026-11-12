// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import {
  GENERAL,
  PEOPLE,
  directWith,
  mockApi,
  expectNoAxeViolations,
  expectTargetSizes,
} from './helpers';

// A camera and a microphone the browser makes up, allowed without asking.
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

const AYSE = PEOPLE[1]!;

const settings = {
  available: true,
  enabled: true,
  guest_start: false,
  max_participants: 8,
  max_bitrate: 2500000,
};
const snapshot = {
  id: '019a0000-0000-7000-8000-000000000001',
  channel_id: GENERAL.id,
  state: 'active',
  revision: 1,
  created_at: '2026-11-05T10:00:00Z',
  ring_until: null,
  started_at: null,
  ended_at: null,
  end_reason: '',
  participants: [],
};
test('installation default-off exposes no call entry', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({ json: { ...settings, available: false, enabled: false } }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start call', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Call settings', exact: true })).toHaveCount(0);
});
test('live state uses revisions and does not re-open an ended call from replay', async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route('**/api/channels/*/call', (route) =>
    route.fulfill({ status: 404, json: { status: 404, code: 'not_found' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start call', exact: true })).toBeVisible();
  api.emit('call.started', snapshot);
  await expect(page.getByRole('region', { name: 'Call in progress' })).toBeVisible();
  await expectNoAxeViolations(page);
  api.emit('call.ended', {
    ...snapshot,
    revision: 2,
    state: 'ended',
    ended_at: new Date().toISOString(),
  });
  api.emit('call.started', snapshot);
  await expect(page.getByRole('region', { name: 'Call in progress' })).toHaveCount(0);
});
test('failed admission releases capture and displays recovery text', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route('**/api/channels/*/call', (route) =>
    route.fulfill({ status: 404, json: { status: 404, code: 'not_found' } }),
  );
  await page.route('**/api/channels/*/calls', (route) =>
    route.fulfill({ status: 201, json: snapshot }),
  );
  await page.route('**/api/calls/*/token', (route) =>
    route.fulfill({ status: 503, json: { status: 503, code: 'media_unavailable' } }),
  );
  await page.route('**/api/calls/*/leave', (route) => route.fulfill({ status: 204 }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  await page.getByTestId('prejoin').getByRole('button', { name: 'Start call' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('check your connection');
  await expect(page.getByRole('button', { name: 'Microphone', exact: true })).toBeDisabled();
});

const dm = directWith(AYSE);
const ringing = (extra: Record<string, unknown> = {}) => ({
  ...snapshot,
  id: '019a0000-0000-7000-8000-000000000002',
  channel_id: dm.id,
  state: 'ringing',
  ring_until: new Date(Date.now() + 30_000).toISOString(),
  participants: [{ id: 'p1', user_id: AYSE.id, state: 'reserved', joined_at: null, left_at: null }],
  ...extra,
});
async function callRoutes(page: import('@playwright/test').Page) {
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route('**/api/channels/*/call', (route) =>
    route.fulfill({ status: 404, json: { status: 404, code: 'not_found' } }),
  );
}
test('an incoming direct call rings and can be declined', async ({ page }) => {
  const api = await mockApi(page, { channels: [dm] });
  await callRoutes(page);
  const answers: unknown[] = [];
  await page.route('**/api/calls/*/answer', (route) => {
    answers.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...ringing(), state: 'ended', end_reason: 'declined' } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  api.emit('call.ringing', ringing());
  const dialog = page.getByRole('dialog', { name: 'Incoming call' });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Decline' }).click();
  await expect(dialog).toHaveCount(0);
  expect(answers).toEqual([{ answer: 'decline' }]);
});
test('paused notifications keep an incoming call silent', async ({ page }) => {
  const api = await mockApi(page, { channels: [dm] });
  api.notifications!.prefs.paused_until = new Date(Date.now() + 3_600_000).toISOString();
  await callRoutes(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  api.emit('call.ringing', ringing());
  // The call still shows in the conversation, but nothing rings.
  await page.goto(`/c/${dm.id}`);
  await expect(page.getByRole('dialog', { name: 'Incoming call' })).toHaveCount(0);
});
test('calling someone who is in another call says so and does not join', async ({ page }) => {
  await mockApi(page, { channels: [dm] });
  await callRoutes(page);
  let tokens = 0;
  await page.route('**/api/channels/*/calls', (route) =>
    route.fulfill({
      status: 201,
      json: {
        ...ringing(),
        state: 'ended',
        end_reason: 'busy',
        ended_at: new Date().toISOString(),
      },
    }),
  );
  await page.route('**/api/calls/*/token', (route) => {
    tokens++;
    return route.fulfill({ status: 409, json: { status: 409, code: 'call_conflict' } });
  });
  await page.goto(`/c/${dm.id}`);
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  await page.getByTestId('prejoin').getByRole('button', { name: 'Start call' }).click();
  await expect(page.getByText('The person you called is in another call.')).toBeVisible();
  expect(tokens).toBe(0);
});
test('an encrypted channel explains why calls are unavailable', async ({ page }) => {
  // MockChannel has no encryption fields; the server sends them for MLS channels.
  await mockApi(page, { general: { encrypted: true, mls: true } as unknown as typeof GENERAL });
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({ json: settings }),
  );
  await page.goto('/');
  await expect(page.getByText('Calls are unavailable in encrypted channels')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Start call', exact: true })).toHaveCount(0);
});
test('the shortcuts dialog lists the call shortcuts', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await page.keyboard.press('Control+/');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog.getByText('Calls', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Leave call', { exact: true })).toBeVisible();
});

test('before joining one sees oneself, hears the microphone and chooses what to join with', async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route('**/api/channels/*/call', (route) =>
    route.fulfill({ status: 404, json: { status: 404, code: 'not_found' } }),
  );
  let started = false;
  await page.route('**/api/channels/*/calls', (route) => {
    started = true;
    return route.fulfill({ status: 201, json: snapshot });
  });
  await page.route('**/api/calls/*/token', (route) =>
    route.fulfill({ status: 503, json: { status: 503, code: 'media_unavailable' } }),
  );
  await page.route('**/api/calls/*/leave', (route) => route.fulfill({ status: 204 }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  const check = page.getByTestId('prejoin');
  await expect(check).toBeVisible();
  // Nothing starts until the person is ready.
  expect(started).toBe(false);
  await expect(check.getByRole('button', { name: 'Microphone on' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await check.getByRole('button', { name: 'Camera off' }).click();
  await expect(check.getByLabel('Your camera')).toBeVisible();
  await expect(check.getByTestId('mic-level')).toContainText(/microphone|Say something/);
  await expectTargetSizes(page, testInfo, '[data-testid="prejoin"]');
  await expectNoAxeViolations(page, '[data-testid="prejoin"]');
  await check.getByRole('button', { name: 'Start call' }).click();
  await expect.poll(() => started).toBe(true);
  // The choice is kept for the next call.
  const kept = await page.evaluate(() => localStorage.getItem('cenacle.call.join'));
  expect(JSON.parse(kept!)).toMatchObject({ audio: true, camera: true, preview: true });
});

test('turning the check off joins at once next time', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'cenacle.call.join',
      JSON.stringify({ audio: false, camera: false, preview: false }),
    ),
  );
  await mockApi(page);
  await page.route('**/api/workspaces/*/calls/settings', (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route('**/api/channels/*/call', (route) =>
    route.fulfill({ status: 404, json: { status: 404, code: 'not_found' } }),
  );
  let started = false;
  await page.route('**/api/channels/*/calls', (route) => {
    started = true;
    return route.fulfill({ status: 201, json: snapshot });
  });
  await page.route('**/api/calls/*/token', (route) =>
    route.fulfill({ status: 503, json: { status: 503, code: 'media_unavailable' } }),
  );
  await page.route('**/api/calls/*/leave', (route) => route.fulfill({ status: 204 }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.getByTestId('prejoin')).toHaveCount(0);
});
