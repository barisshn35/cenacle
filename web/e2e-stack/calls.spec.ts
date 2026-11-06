// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { IDP_URL, idpEnv } from '../playwright.stack.config';

const password = 'e2e stack password 2026';
test.skip(process.env.STACK_CALLS !== '1', 'operator media stack and explicit node IP required');
test.beforeAll(() => {
  if (process.env.STACK_CALLS !== '1') return;
  for (const [email, name] of [
    ['deniz@example.com', 'Deniz Kaya'],
    ['calls-peer@example.com', 'Call Peer'],
    ['calls-third@example.com', 'Call Third'],
  ]) {
    const run = (args: string[]) =>
      execFileSync('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], {
        cwd: '../idp',
        env: { ...process.env, ...idpEnv },
        input: `${password}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    try {
      run(['users', 'create', '--email', email!, '--name', name!, '--verified']);
    } catch {
      run(['users', 'set-password', '--email', email!]);
    }
  }
});
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByLabel('E-mail address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
}
test('real chat/media stack forwards camera/audio, reconnects without duplicate participants and writes an outcome', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const first = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const second = await browser.newContext({ permissions: ['camera', 'microphone'] });
  try {
    const a = await first.newPage();
    const b = await second.newPage();
    // A's signalling socket passes through the test, so the test can cut it.
    let signal: { page: WebSocketRoute; server: WebSocketRoute } | undefined;
    await a.routeWebSocket(/\/media\/ws$/, (page) => {
      signal = { page, server: page.connectToServer() };
    });
    const receivesVideo = () =>
      b
        .locator('video')
        .evaluateAll((elements) =>
          elements.some(
            (video) => video instanceof HTMLVideoElement && video.videoWidth > 0 && !video.muted,
          ),
        );
    await login(a, 'deniz@example.com');
    await a.getByRole('button', { name: 'Call settings', exact: true }).click();
    await a.getByLabel('Allow calls in this workspace', { exact: true }).check();
    await a.getByRole('button', { name: 'Save call settings' }).click();
    await a.getByRole('button', { name: 'Start call', exact: true }).click();
    await expect(a.getByRole('dialog').getByText('Connected', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await login(b, 'calls-peer@example.com');
    await b
      .getByRole('region', { name: 'Call in progress' })
      .getByRole('button', { name: 'Join call' })
      .click();
    await expect(b.getByRole('dialog').getByText('Connected', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await a.getByRole('button', { name: 'Microphone', exact: true }).click();
    await a.getByRole('button', { name: 'Camera', exact: true }).click();
    await expect.poll(receivesVideo, { timeout: 20000 }).toBe(true);
    await expect
      .poll(() =>
        b
          .locator('video')
          .evaluateAll((elements) =>
            elements.some(
              (video) =>
                video instanceof HTMLVideoElement &&
                (video.srcObject as MediaStream | null)
                  ?.getAudioTracks()
                  .some((track) => track.readyState === 'live'),
            ),
          ),
      )
      .toBe(true);
    await a.getByRole('button', { name: 'Minimize call' }).click();
    // Lose the connection to the media server: A comes back as the same participant
    // and publishes again. (Browser offline emulation does not stop WebRTC traffic.)
    const lost = signal!;
    await lost.server.close({ code: 1011 });
    await lost.page.close({ code: 1011 });
    await expect(a.getByText(/Reconnecting/).first()).toBeVisible({ timeout: 10000 });
    await expect(a.getByText(/Connected/).first()).toBeVisible({ timeout: 30000 });
    expect(signal).not.toBe(lost);
    await expect.poll(receivesVideo, { timeout: 20000 }).toBe(true);
    const channelID = new URL(a.url()).pathname.split('/').at(-1)!;
    const snapshot = (await (await a.request.get(`/api/channels/${channelID}/call`)).json()) as {
      participants: { id: string; state: string }[];
    };
    const active = snapshot.participants.filter((person) => person.state !== 'left');
    expect(active).toHaveLength(2);
    expect(new Set(active.map((person) => person.id)).size).toBe(2);
    await a.getByRole('button', { name: 'Leave call', exact: true }).click();
    await b.getByRole('button', { name: 'Leave call', exact: true }).click();
    await expect(b.getByTestId('call-summary')).toBeVisible({ timeout: 15000 });
  } finally {
    await first.close();
    await second.close();
  }
});

async function enableCalls(page: Page) {
  await page.getByRole('button', { name: 'Call settings', exact: true }).click();
  const allow = page.getByLabel('Allow calls in this workspace', { exact: true });
  if (!(await allow.isChecked())) await allow.check();
  await page.getByRole('button', { name: 'Save call settings' }).click();
}
const connected = (page: Page) =>
  expect(page.getByRole('dialog').getByText('Connected', { exact: true })).toBeVisible({
    timeout: 30000,
  });

test('a direct call rings the other person, who can decline and then accept', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const first = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const second = await browser.newContext({ permissions: ['camera', 'microphone'] });
  try {
    const a = await first.newPage();
    const b = await second.newPage();
    await login(a, 'deniz@example.com');
    await enableCalls(a);
    await login(b, 'calls-peer@example.com');
    const nav = a.getByRole('navigation', { name: 'Channels' });
    await nav.getByRole('button', { name: 'New conversation' }).click();
    const dialog = a.getByRole('dialog', { name: 'New conversation' });
    await dialog.getByLabel('Find people').fill('call peer');
    await dialog.getByRole('button', { name: 'Add Call Peer' }).click();
    await dialog.getByRole('button', { name: 'Start conversation' }).click();
    await expect(a.getByRole('heading', { level: 1 })).toHaveText('Call Peer');

    // Declined: the caller's call ends and the conversation says so.
    await a.getByRole('button', { name: 'Start call', exact: true }).click();
    await expect(a.getByText('Calling…').first()).toBeVisible({ timeout: 30000 });
    const ringing = b.getByRole('dialog', { name: 'Incoming call' });
    await expect(ringing).toBeVisible({ timeout: 15000 });
    await ringing.getByRole('button', { name: 'Decline' }).click();
    await expect(a.getByTestId('call-summary').filter({ hasText: 'Call declined' })).toBeVisible({
      timeout: 15000,
    });

    // Accepted: both are connected; the caller no longer waits.
    await a.getByRole('button', { name: 'Start call', exact: true }).click();
    await expect(ringing).toBeVisible({ timeout: 15000 });
    await ringing.getByRole('button', { name: 'Accept' }).click();
    await connected(b);
    await expect(a.getByRole('dialog').getByText('Connected', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await a.getByRole('button', { name: 'Leave call', exact: true }).click();
    await b.getByRole('button', { name: 'Leave call', exact: true }).click();
    await expect(
      a.getByTestId('call-summary').filter({ hasText: 'Call ended' }).first(),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await first.close();
    await second.close();
  }
});

test('three people in a channel call; one screen is shared at a time, video only', async ({
  browser,
}) => {
  test.setTimeout(150000);
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })),
  );
  try {
    const [a, b, c] = await Promise.all(contexts.map((context) => context.newPage()));
    await login(a!, 'deniz@example.com');
    await enableCalls(a!);
    await a!.getByRole('button', { name: 'Start call', exact: true }).click();
    await connected(a!);
    for (const [page, email] of [
      [b!, 'calls-peer@example.com'],
      [c!, 'calls-third@example.com'],
    ] as const) {
      await login(page, email);
      await page
        .getByRole('region', { name: 'Call in progress' })
        .getByRole('button', { name: 'Join call' })
        .click();
      await connected(page);
    }
    await expect(a!.getByRole('dialog').getByRole('region', { name: /./ })).toHaveCount(3);

    await a!.getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect(a!.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible();
    for (const page of [b!, c!])
      await expect
        .poll(
          () =>
            page
              .getByLabel('Deniz Kaya · Screen')
              .evaluate(
                (video) =>
                  video instanceof HTMLVideoElement &&
                  video.videoWidth > 0 &&
                  !(video.srcObject as MediaStream | null)?.getAudioTracks().length,
              )
              .catch(() => false),
          { timeout: 20000 },
        )
        .toBe(true);

    // A second screen is refused while the first is shared.
    await b!.getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect(b!.getByRole('dialog').getByRole('alert')).toContainText(
      'Someone is already sharing their screen',
    );
    await a!.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    await expect(c!.getByLabel('Deniz Kaya · Screen')).toHaveCount(0, { timeout: 15000 });

    for (const page of [a!, b!, c!])
      await page.getByRole('button', { name: 'Leave call', exact: true }).click();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
