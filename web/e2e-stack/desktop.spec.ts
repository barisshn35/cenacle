// SPDX-License-Identifier: AGPL-3.0-only
// The desktop app against the whole stack: it pairs with the web app's
// address, signs in in its own window at Cenacle ID, and opens the chat
// with its own title bar. Needs Electron's libraries and a display (the CI
// image, under Xvfb): set CENACLE_DESKTOP_E2E=1.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { IDP_URL, WEB_URL, idpEnv } from '../playwright.stack.config';

test.skip(!process.env.CENACLE_DESKTOP_E2E, 'CENACLE_DESKTOP_E2E is not set');

const EMAIL = 'desktop@example.com';
const PASSWORD = 'e2e stack password 2026';

test.beforeAll(() => {
  const run = (args: string[]) =>
    execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], {
      cwd: '../idp',
      env: { ...process.env, ...idpEnv },
      input: `${PASSWORD}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  try {
    run(['users', 'create', '--email', EMAIL, '--name', 'Selin Arslan', '--verified']);
  } catch {
    run(['users', 'set-password', '--email', EMAIL]);
  }
  execFileSync('pnpm', ['--filter', '@cenacle/desktop', 'build'], { stdio: 'ignore' });
});

async function windowAt(app: ElectronApplication, prefix: string): Promise<Page> {
  await expect
    .poll(() => app.windows().some((w) => w.url().startsWith(prefix)), { timeout: 20_000 })
    .toBe(true);
  return app.windows().find((w) => w.url().startsWith(prefix))!;
}

test('the desktop app pairs, signs in inside the app and opens the chat', async () => {
  test.setTimeout(120_000);
  const app = await electron.launch({
    args: [
      fileURLToPath(new URL('../../desktop', import.meta.url)),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      CENACLE_DESKTOP_DATA: mkdtempSync(join(tmpdir(), 'cenacle-desktop-')),
      LANG: 'en_US.UTF-8',
    },
  });
  const pair = await app.firstWindow();
  await pair.getByLabel('Server address').fill(WEB_URL);
  await pair.getByRole('button', { name: 'Continue' }).click();

  // Cenacle ID's own page, in a view of the app's sign-in window.
  const signin = await windowAt(app, `${IDP_URL}/`);
  await signin.getByLabel('E-mail address').fill(EMAIL);
  await signin.getByLabel('Password').fill(PASSWORD);
  await signin.getByRole('button', { name: 'Sign in', exact: true }).click();

  const main = await windowAt(app, WEB_URL);
  await expect(main.getByTestId('current-user')).toHaveText('Selin Arslan', { timeout: 20_000 });
  // The app's bar instead of a system title bar and menu.
  await expect(main.getByTestId('desktop-title-bar')).toContainText(new URL(WEB_URL).host);
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu());
  expect(menu).toBeNull();
  // The devices list names the desktop app.
  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(main.getByTestId('device').first()).toContainText('Cenacle desktop app');
  const settings = main.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toContainText(new URL(WEB_URL).host);
  // The app's own version, not Electron's.
  const version = (await import('../../desktop/package.json', { with: { type: 'json' } })).default
    .version;
  await expect(settings).toContainText(version);
  if (process.env.SHOTS) {
    await main.screenshot({ path: join(process.env.SHOTS, 'desktop-stack.png') });
    // The whole window with its bar and buttons (X screenshot; local review only).
    await main.keyboard.press('Escape');
    await main.waitForTimeout(500);
    try {
      execFileSync('import', ['-window', 'root', join(process.env.SHOTS, 'desktop-window.png')]);
    } catch {
      // No ImageMagick here.
    }
  }
  await app.close();
});

// A soak run: the app stays signed in while messages keep arriving, and its
// memory must level off. CENACLE_DESKTOP_SOAK_MINUTES sets the length (two
// minutes by default; the release report records a longer run).
test('the desktop app keeps its memory while messages keep coming', async () => {
  const minutes = Number(process.env.CENACLE_DESKTOP_SOAK_MINUTES ?? '2');
  test.setTimeout((minutes + 3) * 60_000);
  const app = await electron.launch({
    args: [
      fileURLToPath(new URL('../../desktop', import.meta.url)),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      CENACLE_DESKTOP_DATA: mkdtempSync(join(tmpdir(), 'cenacle-desktop-')),
      LANG: 'en_US.UTF-8',
    },
  });
  const pair = await app.firstWindow();
  await pair.getByLabel('Server address').fill(WEB_URL);
  await pair.getByRole('button', { name: 'Continue' }).click();
  const signin = await windowAt(app, `${IDP_URL}/`);
  await signin.getByLabel('E-mail address').fill(EMAIL);
  await signin.getByLabel('Password').fill(PASSWORD);
  await signin.getByRole('button', { name: 'Sign in', exact: true }).click();
  const main = await windowAt(app, WEB_URL);
  await expect(main.getByTestId('current-user')).toHaveText('Selin Arslan', { timeout: 20_000 });
  await main.waitForURL(/\/c\/[0-9a-f-]{36}/);
  const channel = main.url().match(/\/c\/([0-9a-f-]{36})/)![1]!;

  const memory = () =>
    app.evaluate(({ app: a }) =>
      Math.round(a.getAppMetrics().reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024),
    );
  const samples: number[] = [];
  const end = Date.now() + minutes * 60_000;
  let sent = 0;
  let nextSample = Date.now();
  while (Date.now() < end) {
    // One message every 1.5 seconds, under the rate limit; the page sends it
    // (the app adds the session), the realtime connection brings it back.
    await main.evaluate(
      ([id, n]) =>
        fetch(`/api/channels/${id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: `Soak message ${n}: the quick brown fox.`,
            nonce: `soak-${n}-${Date.now()}`,
          }),
        }).then((r) => r.status),
      [channel, sent] as const,
    );
    sent++;
    if (Date.now() >= nextSample) {
      samples.push(await memory());
      nextSample += 60_000;
    }
    await main.waitForTimeout(1_500);
  }
  samples.push(await memory());
  await expect(main.getByTestId('message').last()).toContainText(`Soak message ${sent - 1}`);
  test.info().annotations.push({
    type: 'soak',
    description: `${sent} messages, MB per minute: ${samples.join(' ')}`,
  });
  // Leveled off: the last sample within half again of the first full minute's.
  const base = samples[1] ?? samples[0]!;
  expect(samples.at(-1)!).toBeLessThan(base * 1.5);
  await app.close();
});
