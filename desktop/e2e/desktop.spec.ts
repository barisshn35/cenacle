// SPDX-License-Identifier: AGPL-3.0-only
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

async function launch(
  data: string,
  policy?: object,
  lang = 'en_US.UTF-8',
  fakeMedia = false,
): Promise<ElectronApplication> {
  const env: Record<string, string> = { CENACLE_DESKTOP_DATA: data, LANG: lang };
  if (policy) {
    env.CENACLE_DESKTOP_POLICY = join(data, 'policy.json');
    writeFileSync(env.CENACLE_DESKTOP_POLICY, JSON.stringify(policy));
  }
  return electron.launch({
    // As root (CI containers) Chromium needs --no-sandbox; the pages still run sandboxed renderers.
    args: [
      join(__dirname, '..'),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      ...(fakeMedia ? ['--use-fake-device-for-media-stream'] : []),
    ],
    env: { ...process.env, ...env },
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

test("a new server's privacy policy shows before going on, in English and Turkish", async () => {
  const POLICY = 'https://example.com/privacy';
  fake.privacyUrl = POLICY;
  try {
    const host = new URL(fake.chat).host;
    const data = mkdtempSync(join(tmpdir(), 'cenacle-desktop-'));
    let app = await launch(data, undefined, 'tr_TR.UTF-8');
    let pair = await app.firstWindow();
    await pair.getByLabel('Sunucu adresi').fill(fake.chat);
    await pair.getByRole('button', { name: 'Devam' }).click();
    await expect(pair.getByRole('heading', { level: 1 })).toHaveText(`${host} sunucusuna bağlanın`);
    await expect(
      pair.getByRole('button', { name: 'Gizlilik politikası (tarayıcınızda açılır)' }),
    ).toBeVisible();
    await app.close();

    app = await launch(data);
    pair = await app.firstWindow();
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await pair.getByLabel('Server address').fill(fake.chat);
    await pair.getByRole('button', { name: 'Continue' }).click();
    await expect(pair.getByRole('heading', { level: 1 })).toHaveText(`Connect to ${host}`);
    await pair.getByRole('button', { name: 'Privacy policy (opens in your browser)' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual([POLICY]);
    // Another address goes back to the form; Continue goes on to signing in.
    await pair.getByRole('button', { name: 'Use another address' }).click();
    await expect(pair.getByLabel('Server address')).toBeVisible();
    await pair.getByRole('button', { name: 'Continue' }).click();
    await pair.getByRole('button', { name: 'Continue' }).click();
    await windowAt(app, `${fake.idp}/login`);
    await app.close();
  } finally {
    fake.privacyUrl = '';
  }
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

test("an organization's policy pairs the app with its server and locks it", async () => {
  const data = mkdtempSync(join(tmpdir(), 'cenacle-desktop-'));
  const app = await launch(data, { server: fake.chat, lockServer: true, disableUpdates: true });
  // No pairing page: straight to signing in at the organization's server.
  await signIn(app);
  const main = await windowAt(app, fake.chat);
  await expect(main.locator('#who')).toHaveText('Signed in as Ayşe Yılmaz');
  const prefs = (await main.evaluate(() =>
    (
      globalThis as unknown as { cenacleDesktop: { prefs: () => Promise<unknown> } }
    ).cenacleDesktop.prefs(),
  )) as { serverLocked: boolean; updates: boolean };
  expect(prefs).toMatchObject({ serverLocked: true, updates: false });
  // Changing the server is refused.
  await main.evaluate(() =>
    (
      globalThis as unknown as { cenacleDesktop: { changeServer: () => Promise<void> } }
    ).cenacleDesktop.changeServer(),
  );
  await expect(main.locator('#who')).toHaveText('Signed in as Ayşe Yılmaz');
  expect(JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')).server).toBe(fake.chat);
  await app.close();
});

test('voice recording prompts only in the signed-in paired main frame and releases its microphone', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cenacle-desktop-voice-'));
  const app = await launch(data, undefined, 'en_US.UTF-8', true);
  try {
    const pair = await app.firstWindow();
    await pair.getByLabel('Server address').fill(fake.chat);
    await pair.getByRole('button', { name: 'Continue' }).click();
    await signIn(app);
    const main = await windowAt(app, fake.chat);
    await expect(main.locator('#who')).toHaveText('Signed in as Ayşe Yılmaz');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async (_window: unknown, options: { detail?: string }) => {
        if (options.detail !== 'Microphone') throw new Error('unexpected permission prompt');
        return { response: 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const result = await main.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const recorder = new MediaRecorder(stream);
      const data = new Promise<number>((resolve) => {
        recorder.ondataavailable = (event) => resolve(event.data.size);
      });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      recorder.stop();
      const size = await data;
      stream.getTracks().forEach((track) => track.stop());
      return { size, ended: stream.getTracks().every((track) => track.readyState === 'ended') };
    });
    expect(result.size).toBeGreaterThan(0);
    expect(result.ended).toBe(true);
    // The web page does not gain a desktopCapturer/permission bypass bridge.
    expect(await main.locator('body').getAttribute('data-bridge-keys')).not.toMatch(
      /capture|permission|source/i,
    );
  } finally {
    await app.close();
  }
});

test('screen sharing picks a screen or window in the app, video only', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cenacle-desktop-screen-'));
  const app = await launch(data);
  try {
    const pair = await app.firstWindow();
    await pair.getByLabel('Server address').fill(fake.chat);
    await pair.getByRole('button', { name: 'Continue' }).click();
    await signIn(app);
    const main = await windowAt(app, fake.chat);
    await expect(main.locator('#who')).toHaveText('Signed in as Ayşe Yılmaz');
    // The native picker menu cannot be clicked from a test: the menu chooses its
    // first source as a person would, and remembers what it offered.
    await app.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = ((template: Electron.MenuItemConstructorOptions[]) => {
        const menu = build(template);
        (globalThis as { offered?: string[] }).offered = template
          .filter((item) => item.click && item.label !== 'Cancel')
          .map((item) => String(item.label));
        menu.popup = () => {
          const source = template.find((item) => item.click && item.label !== 'Cancel');
          setTimeout(() => source?.click?.({} as never, undefined, {} as never), 50);
        };
        return menu;
      }) as typeof Menu.buildFromTemplate;
    });
    await main.evaluate(() => {
      const share = (audio: boolean) => async () => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio });
          const result = {
            video: stream.getVideoTracks().length,
            audio: stream.getAudioTracks().length,
          };
          stream.getTracks().forEach((track) => track.stop());
          document.body.dataset.share = JSON.stringify(result);
        } catch (error) {
          document.body.dataset.share = (error as Error).name;
        }
      };
      for (const [id, audio] of [
        ['share', false],
        ['share-audio', true],
      ] as const) {
        const button = document.createElement('button');
        button.id = id;
        button.textContent = id;
        button.onclick = share(audio);
        document.body.append(button);
      }
    });
    // (A request needs a click; Playwright's evaluate counts as one, so a test of
    // the refusal without a click would prove nothing here.)
    await main.locator('#share').click();
    await expect(main.locator('body')).toHaveAttribute('data-share', '{"video":1,"audio":0}');
    expect(
      ((await app.evaluate(() => (globalThis as { offered?: string[] }).offered)) ?? []).length,
    ).toBeGreaterThan(0);
    // System or tab audio is never shared.
    await main.locator('#share-audio').click();
    await expect(main.locator('body')).not.toHaveAttribute('data-share', /video/);
  } finally {
    await app.close();
  }
});
