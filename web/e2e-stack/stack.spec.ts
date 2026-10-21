// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { IDP_URL, WEB_URL, idpEnv } from '../playwright.stack.config';

const EMAIL = 'deniz@example.com';
const PASSWORD = 'e2e stack password 2026';
const SECOND = { email: 'mert@example.com', name: 'Mert Demir' };
const THIRD = { email: 'zeynep@example.com', name: 'Zeynep Ak' };
// Signs in only in the "sign out everywhere" test, so it has exactly two devices.
const FOURTH = { email: 'leyla@example.com', name: 'Leyla Kaya' };

/** RFC 6238 code (SHA-1, 6 digits, 30 s) of a base32 secret, for the time step `step`. */
function totp(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Creates an account at Cenacle ID with its CLI (or resets its password). */
function ensureAccount(email = EMAIL, name = 'Deniz Kaya') {
  const run = (args: string[]) =>
    execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], {
      cwd: '../idp',
      env: { ...process.env, ...idpEnv },
      input: `${PASSWORD}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  try {
    run(['users', 'create', '--email', email, '--name', name, '--verified']);
  } catch {
    run(['users', 'set-password', '--email', email]);
  }
}

test.beforeAll(() => {
  ensureAccount();
  ensureAccount(SECOND.email, SECOND.name);
  ensureAccount(THIRD.email, THIRD.name);
  ensureAccount(FOURTH.email, FOURTH.name);
});

async function signInAtIdP(page: Page, email = EMAIL) {
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByLabel('E-mail address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('signing in with Cenacle ID and out again', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname)) external.push(r.url());
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await signInAtIdP(page);
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/); // General
  await expect(page.getByTestId('current-user')).toHaveText('Deniz Kaya');

  const cookie = (await page.context().cookies(WEB_URL)).find((c) => c.name === 'cenacle_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

  // The session outlives a reload.
  await page.reload();
  await expect(page.getByTestId('current-user')).toHaveText('Deniz Kaya');

  // Signing out ends the chat session and, after confirming, the Cenacle ID session.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin$/);
  expect((await page.request.get('/api/session')).status()).toBe(401);

  // Signing in again asks for the password: single sign-on ended too.
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
  expect(external).toEqual([]);
});

test('cancelling at Cenacle ID returns to the sign-in page with an explanation', async ({
  page,
}) => {
  await page.goto('/signin');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page).toHaveURL(/\/signin\?error=cancelled/);
  await expect(page.getByRole('status')).toContainText('Sign-in was cancelled.');
});

test('a session cannot be used from another origin', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await signInAtIdP(page);
  await expect(page.getByTestId('current-user')).toBeVisible();
  const token = (await page.context().cookies(WEB_URL)).find(
    (c) => c.name === 'cenacle_session',
  )!.value;

  const res = await request.post(`${WEB_URL}/api/auth/logout`, {
    headers: { Cookie: `cenacle_session=${token}`, Origin: 'https://evil.example' },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).code).toBe('cross_site_request');
  // Still signed in.
  expect((await page.request.get('/api/session')).status()).toBe(200);
});

test('two people chat live, also after a reconnect', async ({ browser }) => {
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  const deniz = await open(EMAIL);
  const mert = await open(SECOND.email);
  const stamp = Date.now().toString(36);

  await deniz.getByLabel('Message General').fill(`Merhaba Mert ${stamp}`);
  await deniz.getByLabel('Message General').press('Enter');
  await expect(mert.getByText(`Merhaba Mert ${stamp}`)).toBeVisible();

  // Mert loses the connection; a message sent meanwhile arrives after it is back.
  await mert.context().setOffline(true);
  await expect(mert.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
  await deniz.getByLabel('Message General').fill(`Kaçırma bunu ${stamp}`);
  await deniz.getByLabel('Message General').press('Enter');
  await mert.context().setOffline(false);
  await expect(mert.getByText(`Kaçırma bunu ${stamp}`)).toBeVisible();
  await expect(mert.getByText(`Kaçırma bunu ${stamp}`)).toHaveCount(1);

  await mert.getByLabel('Message General').fill(`Selam Deniz ${stamp}`);
  await mert.getByLabel('Message General').press('Enter');
  await expect(deniz.getByText(`Selam Deniz ${stamp}`)).toBeVisible();
});

test('Central is for announcements; only the administrator creates channels', async ({
  browser,
}) => {
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  // deniz@example.com is CENACLE_ADMIN_EMAIL in this stack.
  const admin = await open(EMAIL);
  const member = await open(SECOND.email);
  const stamp = Date.now().toString(36);

  // Everyone is in Central; only the administrator can write there.
  await member.getByRole('link', { name: 'Central' }).click();
  await expect(member.getByTestId('read-only-notice')).toBeVisible();
  await admin.getByRole('link', { name: 'Central' }).click();
  await admin.getByLabel('Message Central').fill(`Duyuru ${stamp}`);
  await admin.getByLabel('Message Central').press('Enter');
  await expect(member.getByText(`Duyuru ${stamp}`)).toBeVisible();

  // Only the administrator sees "Create a channel".
  await expect(member.getByRole('button', { name: 'Create a channel' })).toHaveCount(0);
  await admin.getByRole('button', { name: 'Create a channel' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Create a channel' });
  await dialog.getByLabel('Name').fill(`Release ${stamp}`);
  await dialog.getByRole('button', { name: 'Create channel' }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText(`Release ${stamp}`);

  // Others find it and join; messages then reach them live.
  await member.getByRole('button', { name: 'Browse channels' }).click();
  await member.getByRole('button', { name: `Join Release ${stamp}` }).click();
  await expect(member.getByRole('heading', { level: 1 })).toHaveText(`Release ${stamp}`);
  await admin.getByLabel(`Message Release ${stamp}`).fill('sürüm çıktı');
  await admin.getByLabel(`Message Release ${stamp}`).press('Enter');
  await expect(member.getByText('sürüm çıktı')).toBeVisible();
});

test('private channels: only their manager adds people', async ({ browser }) => {
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  const admin = await open(EMAIL);
  const member = await open(SECOND.email);
  const name = `Gizli ${Date.now().toString(36)}`;

  await admin.getByRole('button', { name: 'Create a channel' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Create a channel' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Private').check();
  await dialog.getByRole('button', { name: 'Create channel' }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText(name);
  await admin.getByLabel(`Message ${name}`).fill('yalnızca üyeler okur');
  await admin.getByLabel(`Message ${name}`).press('Enter');

  // The other user cannot find it.
  await member.getByRole('button', { name: 'Browse channels' }).click();
  const directory = member.getByRole('dialog', { name: 'Channels' });
  await expect(directory.getByText('General', { exact: true })).toBeVisible();
  await expect(directory.getByText(name)).toHaveCount(0);
  await member.keyboard.press('Escape');

  // The manager adds them; the channel appears for them at once.
  await admin.getByRole('complementary').getByRole('button', { name: 'Add people' }).click();
  const add = admin.getByRole('dialog', { name: `Add people to ${name}` });
  await add.getByLabel('Find people by name or e-mail').fill('mert@');
  await add.getByRole('button', { name: `Add ${SECOND.name}` }).click();
  await expect(add.getByText('Member', { exact: true })).toBeVisible();

  await member.getByRole('link', { name }).click();
  await expect(member.getByText('yalnızca üyeler okur')).toBeVisible();
  await expect(
    member.getByRole('complementary').getByRole('button', { name: 'Add people' }),
  ).toHaveCount(0);
});

test('edits and deletions reach others live; Undo restores', async ({ browser }) => {
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  const author = await open(SECOND.email);
  const reader = await open(EMAIL);
  const stamp = Date.now().toString(36);

  await author.getByLabel('Message General').fill(`taslak ${stamp}`);
  await author.getByLabel('Message General').press('Enter');
  await expect(reader.getByText(`taslak ${stamp}`)).toBeVisible();

  const mine = author.getByTestId('message').filter({ hasText: `taslak ${stamp}` });
  await mine.hover();
  await mine.getByRole('button', { name: 'Message actions' }).click();
  await author.getByRole('menuitem', { name: 'Edit' }).click();
  await author.getByLabel('Edit message').fill(`son hali ${stamp}`);
  await author.getByLabel('Edit message').press('Enter');
  await expect(
    reader.getByTestId('message').filter({ hasText: `son hali ${stamp}` }),
  ).toContainText('(edited)');

  const edited = author.getByTestId('message').filter({ hasText: `son hali ${stamp}` });
  await edited.hover();
  await edited.getByRole('button', { name: 'Message actions' }).click();
  await author.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(reader.getByText(`son hali ${stamp}`)).toHaveCount(0);
  await author.getByRole('button', { name: 'Undo' }).click();
  await expect(reader.getByText(`son hali ${stamp}`)).toBeVisible();
});

test('a workspace by invitation: create, invite, join, talk', async ({ browser }) => {
  test.setTimeout(90_000); // two sign-ins and a whole flow
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  const admin = await open(EMAIL);
  const member = await open(SECOND.email);
  const name = `Ekip ${Date.now().toString(36)}`;

  await admin.getByRole('button', { name: 'Add a workspace' }).click();
  await admin.getByLabel('New workspace').fill(name);
  await admin.getByRole('button', { name: 'Create workspace' }).click();
  await expect(admin.getByRole('button', { name: `Workspace menu: ${name}` })).toBeVisible();
  await admin.getByLabel('Message General').waitFor();

  await admin.getByRole('button', { name: `Workspace menu: ${name}` }).click();
  await admin.getByRole('menuitem', { name: 'Invite people' }).click();
  await admin.getByRole('button', { name: 'Create link' }).click();
  const link = await admin.getByLabel('Invitation link').inputValue();
  await admin.keyboard.press('Escape');

  // The other user does not have the workspace until they follow the link.
  const rail = member.getByRole('navigation', { name: 'Workspaces' });
  await expect(rail.getByRole('link', { name })).toHaveCount(0);
  await member.goto(link);
  await member.getByRole('button', { name: `Join ${name}` }).click();
  await expect(rail.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
  await member.getByLabel('Message General').fill('selam ekip');
  await member.getByLabel('Message General').press('Enter');
  await expect(admin.getByText('selam ekip')).toBeVisible();
});

test('a direct conversation: unread count, typing and presence', async ({ browser }) => {
  const open = async (email: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  const deniz = await open(EMAIL);
  const mert = await open(SECOND.email);
  const stamp = Date.now().toString(36);

  // Deniz starts a conversation with Mert.
  const nav = deniz.getByRole('navigation', { name: 'Channels' });
  await nav.getByRole('button', { name: 'New conversation' }).click();
  const dialog = deniz.getByRole('dialog', { name: 'New conversation' });
  await dialog.getByLabel('Find people').fill('mert');
  await dialog.getByRole('button', { name: `Add ${SECOND.name}` }).click();
  await dialog.getByRole('button', { name: 'Start conversation' }).click();
  await expect(deniz.getByRole('heading', { level: 1 })).toHaveText(SECOND.name);
  // Mert is online: his presence shows on the conversation.
  await expect(nav.getByRole('link', { name: new RegExp(SECOND.name) })).toContainText('Online');

  const box = deniz.getByLabel(`Message ${SECOND.name}`);
  await box.pressSequentially('Selam');
  await box.fill(`Özel mesaj ${stamp}`);
  await box.press('Enter');

  // Mert sees the conversation with one unread message, opens it and reads it.
  const mertNav = mert.getByRole('navigation', { name: 'Channels' });
  const item = mertNav.getByRole('link', { name: /Deniz Kaya/ });
  await expect(item).toContainText('1 unread message');
  await item.click();
  await expect(mert.getByText(`Özel mesaj ${stamp}`)).toBeVisible();
  await expect(item).not.toContainText('unread');

  // Typing reaches the other side.
  await mert.getByLabel('Message Deniz Kaya').pressSequentially('Yazıyorum');
  await expect(deniz.getByTestId('typing')).toHaveText('Mert Demir is typing…');
});

test('"Sign out everywhere" signs the other device out at once', async ({ browser }) => {
  const open = async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
    await signInAtIdP(page, FOURTH.email);
    await page.getByLabel('Message General').waitFor();
    return page;
  };
  const laptop = await open();
  const phone = await open();

  await laptop.getByRole('button', { name: 'Settings' }).click();
  await expect(laptop.getByTestId('device')).toHaveCount(2);
  await laptop.getByRole('button', { name: 'Sign out everywhere' }).click();
  await laptop
    .getByRole('alertdialog', { name: 'Sign out everywhere?' })
    .getByRole('button', { name: 'Sign out everywhere' })
    .click();
  await expect(laptop.getByText('1 device was signed out.')).toBeVisible();

  // The phone's connection closes and the app asks to sign in again.
  await expect(phone).toHaveURL(/\/signin\?error=session_expired/, { timeout: 10_000 });
  await expect(laptop.getByTestId('device')).toHaveCount(1);
});

test('with two-step verification, signing in asks for a code', async ({ page }) => {
  test.setTimeout(90_000);
  // Turn it on at the Cenacle ID account page.
  await page.goto(`${IDP_URL}/account`);
  await page.getByLabel('E-mail address').fill(THIRD.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Set up two-step verification' }).click();
  const secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s/g, '');
  const step = Math.floor(Date.now() / 30_000);
  await page.getByLabel('Verification code').fill(totp(secret, step));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);

  // Signing in to Cenacle now needs a code; each code works once, so wait for the next.
  await page.goto('/');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await signInAtIdP(page, THIRD.email);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Two-step verification');
  while (Math.floor(Date.now() / 30_000) <= step) await page.waitForTimeout(500);
  await page.getByLabel('Verification code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByLabel('Message General')).toBeVisible();
  await expect(page.getByTestId('current-user')).toHaveText(THIRD.name);
});
