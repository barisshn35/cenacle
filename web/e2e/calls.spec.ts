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

/** The server's list of calls going on (the sidebar's marks), kept by the test. */
async function activeCalls(page: import('@playwright/test').Page) {
  const list: unknown[] = [];
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/calls$/, (route) =>
    route.fulfill({ json: { calls: list } }),
  );
  return list;
}

const startedNow = (channelId: string, by: string, extra: Record<string, unknown> = {}) => ({
  ...snapshot,
  id: '019a0000-0000-7000-8000-0000000000c1',
  channel_id: channelId,
  state: 'active',
  created_at: new Date().toISOString(),
  participants: [{ id: 'c1', user_id: by, state: 'reserved', joined_at: null, left_at: null }],
  ...extra,
});

test.describe('call notices', () => {
  test.skip(({ isMobile }) => isMobile, 'the sidebar is in the drawer on phones');

  test('a call starting in a channel is told with Join, and marked in the sidebar', async ({
    page,
  }) => {
    const api = await mockApi(page);
    await callRoutes(page);
    const going = await activeCalls(page);
    const listed = page.waitForResponse(/\/workspaces\/[0-9a-f-]{36}\/calls$/);
    await page.goto(`/c/${GENERAL.id}`);
    await listed;
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    going.push(startedNow(GENERAL.id, AYSE.id));
    api.emit('call.participants', startedNow(GENERAL.id, AYSE.id));
    await expect(page.getByText('Ayşe Yılmaz started a call in General')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Channels' });
    const mark = nav.getByRole('link', { name: /General/ }).getByTestId('call-mark');
    await expect(mark).toBeVisible();
    await expect(mark).toContainText('1');
    // Ended: the mark goes.
    going.length = 0;
    api.emit('call.ended', {
      ...startedNow(GENERAL.id, AYSE.id),
      revision: 9,
      state: 'ended',
      ended_at: new Date().toISOString(),
    });
    await expect(mark).toHaveCount(0);
  });

  test('a call in a muted channel, or with the notice turned off, stays quiet', async ({
    page,
  }) => {
    const api = await mockApi(page);
    await callRoutes(page);
    api.notifications!.prefs = {
      ...api.notifications!.prefs,
      calls: { ring: true, channel: false, sound: 'marimba' },
    };
    const going = await activeCalls(page);
    const listed = page.waitForResponse(/\/workspaces\/[0-9a-f-]{36}\/calls$/);
    await page.goto('/');
    await listed;
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    going.push(startedNow(GENERAL.id, AYSE.id));
    api.emit('call.participants', startedNow(GENERAL.id, AYSE.id));
    const nav = page.getByRole('navigation', { name: 'Channels' });
    await expect(nav.getByTestId('call-mark')).toBeVisible();
    await expect(page.getByText('started a call in General')).toHaveCount(0);
  });

  test('a group call rings everyone; declining only stops the ringing here', async ({ page }) => {
    const group = directWith(AYSE, {
      id: '01a15e50-dddd-7000-8000-0000000000b2',
      name: 'group:x',
      kind: 'group',
      participants: [AYSE, PEOPLE[2]],
    });
    const api = await mockApi(page, { channels: [group] });
    await callRoutes(page);
    let answered = false;
    await page.route('**/api/calls/*/answer', (route) => {
      answered = true;
      return route.fulfill({ status: 403 });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    api.emit('call.participants', startedNow(group.id, AYSE.id));
    const ringing = page.getByRole('dialog', { name: /Incoming call/ });
    await expect(ringing).toBeVisible();
    await expectNoAxeViolations(page, '[role="dialog"]');
    await ringing.getByRole('button', { name: 'Decline' }).click();
    await expect(ringing).toHaveCount(0);
    expect(answered).toBe(false);
  });

  test('calls can be told or not, and their ring tone chosen', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Notifications' }).click();
    const panel = dialog.getByTestId('notifications-panel');
    await panel.getByLabel('Direct and group calls ring').click();
    await expect.poll(() => (api.notifications!.prefs.calls as { ring: boolean }).ring).toBe(false);
    await panel.getByRole('combobox', { name: 'Ring tone' }).selectOption('gong');
    await expect
      .poll(() => (api.notifications!.prefs.calls as { sound: string }).sound)
      .toBe('gong');
  });
});

async function startRoutes(page: import('@playwright/test').Page) {
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
}

test('noise suppression and background blur load on the device and are remembered', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'one run is enough: the work is the same');
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const loaded: string[] = [];
  page.on('response', (r) => {
    if (/selfie_segmenter|vision_wasm_internal|rnnoise/.test(r.url()))
      loaded.push(`${r.status()} ${r.url().split('/').pop()}`);
  });
  await mockApi(page);
  await startRoutes(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  const check = page.getByTestId('prejoin');
  await check.getByRole('button', { name: 'Camera off' }).click();
  await check.getByLabel('Noise suppression').selectOption('strong');
  await expect(check.getByText('Also removes typing')).toBeVisible();
  await check.getByLabel('Blur my background').check();
  // The model and the WebAssembly come from the app's own origin.
  await expect
    .poll(() => loaded.filter((l) => l.startsWith('200')).length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(check.getByLabel('Your camera', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  const kept = await page.evaluate(() => localStorage.getItem('cenacle.call.effects'));
  expect(JSON.parse(kept!)).toEqual({ noise: 'strong', background: 'blur' });
});
