// SPDX-License-Identifier: AGPL-3.0-only
//
// What each role may do, on the real stack: the instance administrator, a
// workspace owner, a member promoted to admin and back, and a guest who came
// through a guest link.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { IDP_URL, WEB_URL } from '../playwright.stack.config';
import { ensureAccount, PASSWORD } from './accounts';

const ADMIN = 'deniz@example.com'; // CENACLE_ADMIN_EMAIL of this stack
const MEMBER = { email: 'mert@example.com', name: 'Mert Demir' };

test.beforeAll(() => {
  ensureAccount(ADMIN, 'Deniz Kaya');
  ensureAccount(MEMBER.email, MEMBER.name);
});

async function open(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByLabel('E-mail address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Message General').waitFor();
  return page;
}

// Every read of the instance administration; each must refuse anyone else.
const ADMIN_READS = [
  '/api/admin/overview',
  '/api/admin/users',
  '/api/admin/workspaces',
  '/api/admin/bots',
  '/api/admin/notification-policy',
  '/api/admin/session-policy',
  '/api/admin/federation-policy',
  '/api/admin/audit',
  '/api/admin/audit-stream',
  '/api/admin/web-app',
  '/api/admin/semantic-search',
  '/api/admin/assistants',
];

test('only the instance administrator reaches the administration', async ({ browser }) => {
  const admin = await open(browser, ADMIN);
  const member = await open(browser, MEMBER.email);
  for (const path of ADMIN_READS) {
    expect.soft((await admin.request.get(path)).status(), `admin ${path}`).toBe(200);
    expect.soft((await member.request.get(path)).status(), `member ${path}`).toBe(403);
  }
  const write = await member.request.put('/api/admin/web-app', {
    headers: { Origin: WEB_URL },
    data: { enabled: false },
  });
  expect(write.status()).toBe(403);
  // The web app is still on for everyone.
  await member.reload();
  await expect(member.getByLabel('Message General')).toBeVisible();
});

test('a member promoted to admin may invite, and no longer once demoted', async ({ browser }) => {
  const owner = await open(browser, ADMIN);
  const member = await open(browser, MEMBER.email);
  const menu = (page: Page) => page.getByRole('button', { name: /^Workspace menu: / }).first();
  const workspace = (await menu(owner).getAttribute('aria-label'))!.replace('Workspace menu: ', '');

  const setRole = async (role: 'admin' | 'member') => {
    await owner.getByRole('button', { name: `Workspace menu: ${workspace}` }).click();
    await owner.getByRole('menuitem', { name: 'Workspace settings' }).click();
    const settings = owner.getByRole('dialog', { name: 'Workspace settings' });
    await settings.getByRole('tab', { name: /^Members/ }).click();
    await settings.getByLabel(`Role of ${MEMBER.name}`).selectOption(role);
    await expect(settings.getByLabel(`Role of ${MEMBER.name}`)).toHaveValue(role);
    await owner.keyboard.press('Escape');
  };
  const canInvite = async () => {
    await member.reload();
    await member.getByRole('button', { name: `Workspace menu: ${workspace}` }).click();
    const n = await member.getByRole('menuitem', { name: 'Invite people' }).count();
    await member.keyboard.press('Escape');
    return n > 0;
  };

  expect(await canInvite()).toBe(false);
  await setRole('admin');
  try {
    await expect.poll(canInvite).toBe(true);
  } finally {
    await setRole('member');
  }
  await expect.poll(canInvite).toBe(false);
});

test('a guest sees only the channel of their link, and leaves when it ends', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const admin = await open(browser, ADMIN);
  const general = admin.url().match(/\/c\/([0-9a-f-]{36})/)![1]!;
  const name = `Misafir ${Date.now().toString(36)}`;

  await admin.getByRole('button', { name: 'Create a channel' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Create a channel' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create channel' }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText(name);
  const channel = admin.url().match(/\/c\/([0-9a-f-]{36})/)![1]!;

  await admin.getByRole('button', { name: 'Channel settings' }).click();
  const settings = admin.getByRole('dialog', { name: 'Channel settings' });
  await settings.getByRole('tab', { name: 'Members and roles' }).click();
  const section = settings.getByTestId('guest-links');
  await section.getByLabel('For whom (optional)').fill('Tedarikçi');
  await section.getByLabel('Password', { exact: true }).fill('misafir-parola-1');
  await section.getByRole('button', { name: 'Create guest link' }).click();
  const link = await section.getByLabel('Guest link', { exact: true }).inputValue();
  await admin.keyboard.press('Escape');

  // Someone without an account joins with the link and its password.
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: `Join ${name}` })).toBeVisible();
  await guest.getByLabel('Your name').fill('Tedarikçi Ali');
  await guest.getByLabel('Password').fill('misafir-parola-1');
  await guest.getByRole('button', { name: 'Join as a guest' }).click();
  await expect(guest).toHaveURL(new RegExp(`/c/${channel}`));
  await guest.getByLabel(`Message ${name}`).fill('merhaba, ben misafirim');
  await guest.getByLabel(`Message ${name}`).press('Enter');
  await expect(admin.getByTestId('message').getByText('merhaba, ben misafirim')).toBeVisible();

  // Nothing else is theirs: no other channel, no workspace tools, no administration.
  await expect(guest.getByRole('button', { name: 'Create a channel' })).toHaveCount(0);
  expect(
    (await guest.request.get(`/api/channels/${general}/messages`)).status(),
  ).toBeGreaterThanOrEqual(400);
  expect((await guest.request.get('/api/admin/overview')).status()).toBe(403);
  const posted = await guest.request.post(`/api/channels/${general}/messages`, {
    headers: { Origin: WEB_URL },
    data: { body: 'izinsiz' },
  });
  expect(posted.status()).toBeGreaterThanOrEqual(400);

  // Ending the link ends the guest's access.
  await admin.getByRole('button', { name: 'Channel settings' }).click();
  const again = admin.getByRole('dialog', { name: 'Channel settings' });
  await again.getByRole('tab', { name: 'Members and roles' }).click();
  await again.getByTestId('guest-links').getByRole('button', { name: 'End link' }).click();
  await expect
    .poll(async () => (await guest.request.get(`/api/channels/${channel}/messages`)).status())
    .toBeGreaterThanOrEqual(400);
});
