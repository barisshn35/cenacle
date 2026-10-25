// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  SESSION,
  type MockApi,
} from './helpers';

/**
 * A delivery service for one channel, enough for one browser: the app makes
 * the MLS group with ts-mls in the page; the server keeps what it is sent.
 */
async function mockDeliveryService(page: Page, mock: MockApi) {
  const state = {
    devices: [] as {
      id: string;
      user_id: string;
      name: string;
      signature_key: string;
      created_at: string;
    }[],
    group: null as null | { epoch: number; group_info: string; members: string[] },
    commits: [] as { epoch: number; data: string }[],
    recovery: null as null | { verifier: string },
    backups: [] as { id: string; data: string }[],
  };
  const api = `**/api/channels/${GENERAL.id}/e2e`;
  await page.route('**/api/e2e/devices', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { devices: state.devices } });
    const body = route.request().postDataJSON() as { name: string; signature_key: string };
    const d = {
      id: `0d0d0d0d-0000-4000-8000-00000000000${state.devices.length + 1}`,
      user_id: SESSION.user.id,
      name: body.name,
      signature_key: body.signature_key,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    };
    state.devices.push(d);
    return route.fulfill({ status: 201, json: d });
  });
  await page.route('**/api/users/*/e2e/devices', (route) =>
    route.fulfill({ json: { devices: state.devices } }),
  );
  const view = () => ({
    epoch: state.group!.epoch,
    group_info: state.group!.group_info,
    members: state.group!.members.map((device_id) => ({
      device_id,
      user_id: SESSION.user.id,
      joined_epoch: 0,
      stale: false,
    })),
  });
  await page.route(api, (route) => {
    if (route.request().method() === 'GET') {
      return state.group
        ? route.fulfill({ json: view() })
        : route.fulfill({ status: 404, json: {} });
    }
    const body = route.request().postDataJSON() as { device_id: string; group_info: string };
    state.group = { epoch: 0, group_info: body.group_info, members: [body.device_id] };
    // The server now lists the channel as encrypted with device keys.
    const general = mock.channels!.find((c) => c.id === GENERAL.id)!;
    Object.assign(general, { encrypted: true, mls: true });
    return route.fulfill({ json: view() });
  });
  await page.route(`${api}/commits*`, (route) =>
    route.fulfill({ json: { commits: state.commits.filter((c) => c.epoch >= 0) } }),
  );
  await page.route(`${api}/backups*`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { backups: [] } });
    state.backups.push({
      id: String(state.backups.length),
      data: (route.request().postDataJSON() as { data: string }).data,
    });
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/e2e/recovery', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: state.recovery ? { set: true, ...state.recovery } : { set: false },
      });
    }
    state.recovery = route.request().postDataJSON() as { verifier: string };
    return route.fulfill({ json: { set: true, ...state.recovery } });
  });
  return state;
}

test('a manager encrypts a channel with device keys; messages leave sealed', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'the details panel is a drawer on phones');
  const mock = await mockApi(page, { admin: true });
  const ds = await mockDeliveryService(page, mock);
  let sent = '';
  await page.route(`**/api/channels/${GENERAL.id}/messages`, (route) => {
    if (route.request().method() === 'POST')
      sent = (route.request().postDataJSON() as { body: string }).body;
    return route.fallback();
  });
  await page.goto(`/c/${GENERAL.id}`);
  const toggle = page.getByRole('button', { name: 'Channel details', exact: true });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const enable = page.getByTestId('enable-encryption');
  await page.mouse.move(0, 0);
  await expectNoAxeViolations(page, '[data-testid="enable-encryption"]');
  await expectTargetSizes(page, testInfo, '[data-testid="enable-encryption"]');
  await enable.getByRole('button', { name: 'Turn on end-to-end encryption' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Encrypt General end to end?' });
  await expect(confirm).toContainText('cannot be turned off');
  await confirm.getByRole('button', { name: 'Turn on end-to-end encryption' }).click();
  await expect(page.getByTestId('encryption-info')).toContainText('Encrypted end to end', {
    timeout: 15_000,
  });
  expect(ds.devices).toHaveLength(1);
  expect(ds.group?.members).toEqual([ds.devices[0]!.id]);

  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.fill('Meet at noon');
  await box.press('Enter');
  await expect.poll(() => sent, { timeout: 15_000 }).toMatch(/^mls:v1:/);
  expect(sent).not.toContain('noon');
  // This device opened its own message.
  await expect(page.getByText('Meet at noon')).toBeVisible();
  await expect(page.getByTestId('encryption-info')).toContainText('1 device can read');
});

test('settings make a recovery key and list this device', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'the settings button is in the drawer on phones');
  const mock = await mockApi(page);
  const ds = await mockDeliveryService(page, mock);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByTestId('encryption-settings');
  await settings.getByRole('button', { name: 'Make a recovery key' }).click();
  const code = settings.getByTestId('recovery-code');
  await expect(code).toHaveText(/^([A-Z2-9]{4} ){12}[A-Z2-9]{4}$/);
  expect(ds.recovery?.verifier).toBeTruthy();
  expect(ds.devices).toHaveLength(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(settings.getByText('This device')).toBeVisible();
  await expect(settings).toContainText('backed up with your recovery key');
  await page.mouse.move(0, 0);
  await expectNoAxeViolations(page, '[data-testid="encryption-settings"]');
  await expectTargetSizes(page, testInfo, '[data-testid="encryption-settings"]');
});
