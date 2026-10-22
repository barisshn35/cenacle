// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  DEFAULT_WS,
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
} from './helpers';

/** A key check and a sealed message, as the app makes them (Node's WebCrypto). */
async function seal(passphrase: string) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(16).fill(7);
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const envelope = async (text: string) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)),
    );
    return `e2e:v1:${b64(iv)}:${b64(data)}`;
  };
  return {
    check: `s:${b64(salt)}:${await envelope('cenacle-key-check')}`,
    hello: await envelope('Top secret plan'),
  };
}

const SETTINGS = {
  retention_days: null,
  default_classification: 'Internal',
  classifications: [
    {
      id: '01a16100-0000-7000-8000-0000000000a1',
      name: 'Internal',
      description: 'For employees only',
      color: 'info',
    },
  ],
  attributes: [{ key: 'department', name: 'Department' }],
};

test('channels show the workspace’s default classification banner', async ({ page }) => {
  await mockApi(page, { messages: [mockMessage(1, 'Hello')] });
  await page.route(`**/api/workspaces/${DEFAULT_WS}/classifications`, (route) =>
    route.fulfill({
      json: {
        classifications: SETTINGS.classifications,
        default_id: SETTINGS.classifications[0]!.id,
      },
    }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  const banner = page.getByTestId('classification');
  await expect(banner).toContainText('Internal');
  await expect(banner).toContainText('For employees only');
  await expectNoAxeViolations(page, '[data-testid="classification"]');
});

test('admins set retention and classifications; owners place legal holds', async ({
  page,
}, testInfo) => {
  await mockApi(page, { messages: [], admin: true });
  let saved: unknown;
  await page.route(`**/api/workspaces/${DEFAULT_WS}/compliance`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: SETTINGS });
    saved = route.request().postDataJSON();
    return route.fulfill({ json: saved });
  });
  await page.route(`**/api/workspaces/${DEFAULT_WS}/member-attributes`, (route) =>
    route.fulfill({ json: { members: [] } }),
  );
  const holds: unknown[] = [];
  let placed: unknown;
  await page.route(`**/api/workspaces/${DEFAULT_WS}/legal-holds`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { holds } });
    placed = route.request().postDataJSON();
    holds.push({
      id: '01a16100-0000-7000-8000-0000000000b1',
      ...(placed as object),
      created_at: '2026-10-22T10:00:00Z',
      message_count: 42,
    });
    return route.fulfill({ status: 201, json: holds[0] });
  });
  await page.goto('/compliance');
  const pageRoot = page.getByTestId('compliance');
  await pageRoot.getByRole('checkbox', { name: 'Keep messages forever' }).uncheck();
  await pageRoot.getByLabel('Days to keep messages').fill('90');
  await pageRoot.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => saved)
    .toMatchObject({ retention_days: 90, default_classification: 'Internal' });
  await page.mouse.move(0, 0);
  await expectTargetSizes(page, testInfo, '[data-testid="compliance"]');
  await expectNoAxeViolations(page, '[data-testid="compliance"]');

  await page.getByRole('button', { name: 'Place a legal hold' }).click();
  const dialog = page.getByRole('dialog', { name: 'Place a legal hold' });
  await dialog.getByLabel('Name', { exact: true }).fill('Case 12');
  await dialog.getByRole('checkbox', { name: 'Ayşe Yılmaz' }).check();
  await page.mouse.move(0, 0);
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Place hold' }).click();
  await expect(dialog).toHaveCount(0);
  expect(placed).toMatchObject({ name: 'Case 12', channel_ids: [] });
  await expect(page.getByTestId('hold')).toContainText('Keeps 42 messages');
});

test('an encrypted channel asks for its passphrase before showing and sending', async ({
  page,
}) => {
  const check = await seal('correct horse battery');
  const secret = { ...mockMessage(1, check.hello) };
  await mockApi(page, {
    messages: [secret],
    general: { encrypted: true, key_check: check.check } as never,
  });
  let sent = '';
  await page.route(`**/api/channels/${GENERAL.id}/messages`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent = (route.request().postDataJSON() as { body: string }).body;
    return route.fallback();
  });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('Encrypted message')).toBeVisible();
  const unlock = page.getByTestId('unlock');
  await expectNoAxeViolations(page, '[data-testid="unlock"]');
  await unlock.getByLabel('This channel is encrypted end to end').fill('wrong passphrase!');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock).toContainText('does not open this channel');
  await unlock.getByLabel('This channel is encrypted end to end').fill('correct horse battery');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Top secret plan')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('textbox', { name: 'Message General' }).fill('Meet at noon');
  await page.getByRole('textbox', { name: 'Message General' }).press('Enter');
  await expect.poll(() => sent).toMatch(/^e2e:v1:/);
  expect(sent).not.toContain('noon');
});
