// SPDX-License-Identifier: AGPL-3.0-only
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFake, TOKEN, type Fake } from './fake-server';

let fake: Fake;
test.beforeAll(async () => {
  fake = await startFake();
});
test.afterAll(async () => {
  await fake.close();
});

async function launch(data: string): Promise<ElectronApplication> {
  return electron.launch({
    // As root (CI containers) Chromium needs --no-sandbox; the pages still run sandboxed renderers.
    args: [join(__dirname, '..'), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
    env: { ...process.env, CENACLE_DESKTOP_DATA: data, LANG: 'en_US.UTF-8' },
  });
}

/** The window whose page is at `prefix`, waiting for it if needed. */
async function windowAt(app: ElectronApplication, prefix: string): Promise<Page> {
  await expect
    .poll(() => app.windows().some((w) => w.url().startsWith(prefix)), { timeout: 15_000 })
    .toBe(true);
  return app.windows().find((w) => w.url().startsWith(prefix))!;
}

async function signIn(app: ElectronApplication, password = 'correct horse') {
  const window = await windowAt(app, `${fake.idp}/login`);
  await window.getByLabel('Username').fill('ayse');
  await window.getByLabel('Password').fill(password);
  await window.getByRole('button', { name: 'Sign in' }).click();
}

test('pairs with a server and signs in inside the app, while the web app is off', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cenacle-desktop-'));
  const app = await launch(data);
  const pair = await app.firstWindow();
  await expect(pair.getByRole('heading', { level: 1 })).toHaveText(
    'Connect to your Cenacle server',
  );

  // Plain http is refused for anything but this computer.
  await pair.getByLabel('Server address').fill('http://chat.example.com');
  await pair.getByRole('button', { name: 'Continue' }).click();
  await expect(pair.getByRole('alert')).toContainText('must use https');

  await pair.getByLabel('Server address').fill(fake.chat);
  await pair.getByRole('button', { name: 'Continue' }).click();

  // The sign-in opens in a window of the app (no browser), at Cenacle ID, titled with its host.
  await windowAt(app, `${fake.idp}/login`);
  const titles = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  await expect.poll(titles).toContainEqual(expect.stringContaining(new URL(fake.idp).host));
  await signIn(app);

  const main = await windowAt(app, fake.chat);
  await expect(main.locator('#who')).toHaveText('Signed in as Ayşe Yılmaz');
  // The bearer token goes along; the page never holds it.
  expect(fake.authorizations).toContain(`Bearer ${TOKEN}`);
  expect(fake.cookies.filter(Boolean)).toEqual([]);
  expect(await main.locator('body').getAttribute('data-bridge-keys')).toBe(
    'changeServer,checkUpdates,platform,prefs,setBadge,setCloseToTray,setTitleBar,signIn,signOut,titleBarHeight,version',
  );
  // No menu bar anywhere: the windows draw their own bar.
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull();
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isMenuBarVisible()),
    ),
  ).toBe(true);
  expect(await app.evaluate(({ app: a }) => a.getVersion())).toBe(
    (await import('../package.json', { with: { type: 'json' } })).default.version,
  );
  expect(
    await main.evaluate(() => JSON.stringify(window.localStorage) + document.cookie),
  ).not.toContain(TOKEN);
  // Nothing of the token in the app's files (no keyring here: it stays in memory).
  for (const f of readdirSync(data)) {
    if (!f.endsWith('.json')) continue;
    expect(readFileSync(join(data, f), 'utf8')).not.toContain(TOKEN);
  }

  // Links open inside the app: other sites in their own window without the bridge,
  // Cenacle ID's pages in theirs; files are saved, not shown.
  await main.locator('#external').click();
  const news = await windowAt(app, `${fake.other}/news`);
  await expect(news.locator('body')).toHaveAttribute('data-bridge', 'false');
  await main.locator('#account').click();
  const account = await windowAt(app, `${fake.idp}/account`);
  await expect(account.locator('body')).toHaveAttribute('data-bridge', 'false');
  expect(app.windows().every((w) => !w.url().startsWith('chrome'))).toBe(true);

  // Signing out forgets the session and opens the sign-in again.
  await main.locator('#signout').click();
  await windowAt(app, `${fake.idp}/login`);
  await app.close();
});

test('a wrong password keeps the person out and the app paired', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cenacle-desktop-'));
  let app = await launch(data);
  const pair = await app.firstWindow();
  await pair.getByLabel('Server address').fill(fake.chat);
  await pair.getByRole('button', { name: 'Continue' }).click();
  await signIn(app, 'wrong');
  // The window closes with the reason; the main window stays signed out.
  await expect
    .poll(() => app.windows().some((w) => w.url().startsWith(`${fake.idp}/login`)))
    .toBe(false);
  const main = await windowAt(app, fake.chat);
  await expect(main.locator('#who')).toHaveText('Signed out');
  await app.close();

  // The next start opens the paired server straight away.
  app = await launch(data);
  await windowAt(app, fake.chat);
  expect(app.windows().some((w) => w.url().includes('pair.html'))).toBe(false);
  await app.close();
});

test('starts quickly and stays within its memory budget', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cenacle-desktop-'));
  const started = Date.now();
  const app = await launch(data);
  const pair = await app.firstWindow();
  await expect(pair.getByLabel('Server address')).toBeVisible();
  const startup = Date.now() - started;
  await pair.getByLabel('Server address').fill(fake.chat);
  await pair.getByRole('button', { name: 'Continue' }).click();
  await signIn(app);
  const main = await windowAt(app, fake.chat);
  await expect(main.locator('#who')).toHaveText('Signed in as Ayşe Yılmaz');
  const memory = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().reduce((sum, p) => sum + p.memory.workingSetSize, 0),
  );
  const byType = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((p) => `${p.type}:${Math.round(p.memory.workingSetSize / 1024)}`),
  );
  test
    .info()
    .annotations.push(
      { type: 'processes', description: byType.join(' ') },
      { type: 'startup', description: `${startup} ms` },
      { type: 'memory', description: `${Math.round(memory / 1024)} MB` },
    );
  // Budgets that catch a regression, not a benchmark: the pairing page within
  // eight seconds on a CI runner, the working sets of all processes together
  // under 800 MB (about 580 MB at 0.30 under Xvfb, where drawing is in software).
  expect(startup).toBeLessThan(8_000);
  expect(memory / 1024).toBeLessThan(800);
  await app.close();
});
