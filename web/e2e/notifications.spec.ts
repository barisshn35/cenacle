// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  PEOPLE,
  RANDOM,
} from './helpers';

test.describe('notifications', () => {
  test.skip(({ isMobile }) => isMobile, 'settings open from the sidebar footer on desktop');

  test('settings list the channels with their own notifications', async ({ page }) => {
    const api = await mockApi(page, { messages: [] });
    api.notifications!.channels = [
      { channel_id: GENERAL.id, level: 'none', muted_until: null, sound: '' },
    ];
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Notifications' }).click();
    const list = dialog.getByTestId('notification-exceptions');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('General');
    await expect(list).toContainText('Nothing');
    await list.getByRole('button', { name: 'Use my default, General' }).click();
    await expect(dialog.getByText('No channel differs from these settings.')).toBeVisible();
  });

  test('settings: pause, levels, sounds and quiet hours', async ({ page }, testInfo) => {
    const api = await mockApi(page, { messages: [] });
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Notifications' }).click();
    const panel = dialog.getByTestId('notifications-panel');

    await panel.getByLabel('In channels').selectOption('mentions');
    await expect.poll(() => api.notifications!.prefs.default_level).toBe('mentions');
    await panel.getByLabel('Stay quiet during these hours').click();
    await expect(panel.getByLabel('From')).toBeVisible();
    await expect
      .poll(() => (api.notifications!.prefs.quiet_hours as { enabled: boolean }).enabled)
      .toBe(true);
    await panel.getByLabel('Pause for').selectOption('1h');
    await expect(panel.getByText(/Paused until/)).toBeVisible();
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    await panel.getByRole('button', { name: 'Resume notifications' }).click();
    await expect(panel.getByText(/Paused until/)).toHaveCount(0);
  });

  test('a channel is muted from its details and dimmed in the sidebar', async ({ page }) => {
    const api = await mockApi(page, { messages: [] });
    await page.goto(`/c/${GENERAL.id}`);
    const details = page.getByTestId('channel-notifications');
    await details.getByLabel('Mute channel').selectOption('forever');
    await expect.poll(() => api.notifications!.channels.length).toBe(1);
    const sidebar = page.locator('body');
    await expect(sidebar.getByText('(muted)')).toHaveCount(1);
    await details.getByLabel('Mute channel').selectOption('');
    await expect(sidebar.getByText('(muted)')).toHaveCount(0);
  });
});

test.describe('search', () => {
  test('finds messages and jumps to an older one', async ({ page }, testInfo) => {
    // More than one page (50) of messages: the result is on an older page.
    const messages = Array.from({ length: 120 }, (_, i) =>
      mockMessage(i + 1, i === 4 ? 'The quarterly report is ready' : `Message number ${i + 1}`),
    );
    await mockApi(page, { messages });
    await page.goto(`/c/${RANDOM.id}`);
    await page.getByRole('button', { name: 'Search messages and files' }).click();
    const panel = page.getByTestId('search-panel');
    await panel.getByRole('searchbox', { name: 'Search for' }).fill('quart');
    const result = panel.getByTestId('search-result');
    await expect(result).toHaveCount(1);
    await expect(result.locator('mark')).toHaveText('quarterly');
    await expectNoAxeViolations(page, '[data-testid="search-panel"]');
    await expectTargetSizes(page, testInfo, '[data-testid="search-panel"]');

    // The highlight is short: note every message that gets it, so a busy
    // machine cannot miss it between two checks.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { highlightedSeen: string[] }).highlightedSeen = seen;
      new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as HTMLElement;
          if (el.dataset.highlighted === 'true' && el.dataset.messageId)
            seen.push(el.dataset.messageId);
        }
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-highlighted'],
      });
    });
    await result.click();
    await expect(page).toHaveURL(new RegExp(`/c/${GENERAL.id}`));
    // On a phone the search covered the channel: it closes to show the message.
    if (testInfo.project.name === 'coarse') await expect(panel).toBeHidden();
    const target = page.locator(`[data-message-id="${messages[4]!.id}"]`);
    // Older pages load first; on a busy machine this takes a while.
    await expect(target).toBeInViewport({ timeout: 15_000 });
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { highlightedSeen: string[] }).highlightedSeen),
      )
      .toContain(messages[4]!.id);
    await expect(target).not.toHaveAttribute('data-highlighted', 'true', { timeout: 8000 });
  });

  test('says when nothing matches', async ({ page }) => {
    await mockApi(page, { messages: [mockMessage(1, 'Hello')] });
    await page.goto(`/c/${GENERAL.id}`);
    // The shortcut works once the app is up.
    await expect(page.getByText('Hello')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Shift+F');
    const panel = page.getByTestId('search-panel');
    await panel.getByRole('searchbox', { name: 'Search for' }).fill('nothing');
    await expect(panel.getByText('No messages found. Try fewer or other words.')).toBeVisible();
  });
});

test.describe('incoming messages', () => {
  // What the page shows and plays: notifications and oscillators are recorded,
  // and the test decides whether the window is in front.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as {
        notes: string[];
        tones: number;
        away: boolean;
        AudioContext: typeof AudioContext;
        Notification: unknown;
      };
      w.notes = [];
      w.tones = 0;
      w.away = false;
      class Recorded {
        static permission = 'granted';
        static requestPermission = () => Promise.resolve('granted');
        onclick: (() => void) | null = null;
        constructor(title: string, options?: { body?: string }) {
          w.notes.push(`${title} | ${options?.body ?? ''}`);
        }
        close() {}
      }
      w.Notification = Recorded;
      const Base = w.AudioContext;
      w.AudioContext = class extends Base {
        createOscillator() {
          w.tones++;
          return super.createOscillator();
        }
      };
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      document.hasFocus = () => !w.away;
    });
  });
  const state = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const w = window as unknown as { notes: string[]; tones: number };
      return { notes: w.notes, tones: w.tones };
    });
  const away = (page: import('@playwright/test').Page, on: boolean) =>
    page.evaluate((v) => ((window as unknown as { away: boolean }).away = v), on);
  // A second channel the person is in, open while messages arrive in General.
  const OPS = {
    ...RANDOM,
    id: '01a15e50-5555-7d7d-bbee-8e7809fd8ad2',
    name: 'Ops',
    is_member: true,
  };
  // The server's defaults: every message, with a sound of its own.
  const defaults = {
    desktop: true,
    default_level: 'all',
    sounds: { message: 'drop', mention: 'chime', direct: 'pop' },
  };

  test('a channel message notifies and sounds while the window is behind others', async ({
    page,
  }) => {
    const api = await mockApi(page, { channels: [OPS] });
    Object.assign(api.notifications!.prefs, defaults);
    await page.goto(`/c/${OPS.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ops');
    // Visible but not focused: another window is in front.
    await away(page, true);
    api.emit('message.created', { ...mockMessage(90, 'Toplantı 15:00') });
    await expect
      .poll(async () => (await state(page)).notes)
      .toEqual(['Ayşe Yılmaz · General | Toplantı 15:00']);
    expect((await state(page)).tones).toBeGreaterThan(0);
  });

  test('nothing while the channel is open in front', async ({ page }) => {
    const api = await mockApi(page, { channels: [OPS] });
    Object.assign(api.notifications!.prefs, defaults);
    await page.goto(`/c/${GENERAL.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('General');
    api.emit('message.created', { ...mockMessage(91, 'Buradayım') });
    await expect(page.getByTestId('message').filter({ hasText: 'Buradayım' })).toBeVisible();
    expect(await state(page)).toEqual({ notes: [], tones: 0 });
  });

  test('mentions only: a plain channel message stays quiet', async ({ page }) => {
    const api = await mockApi(page, { channels: [OPS] });
    Object.assign(api.notifications!.prefs, defaults, { default_level: 'mentions' });
    await page.goto(`/c/${OPS.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ops');
    await away(page, true);
    api.emit('message.created', { ...mockMessage(92, 'Sessiz') });
    // A mention after it does notify: the plain message was handled and stayed quiet.
    api.emit('message.created', {
      ...mockMessage(93, 'Bakar mısın'),
      mentions: [{ id: PEOPLE[0]!.id, display_name: PEOPLE[0]!.display_name }],
    });
    await expect
      .poll(async () => (await state(page)).notes)
      .toEqual(['Ayşe Yılmaz · General | Bakar mısın']);
  });

  test('the desktop app shows the notification itself', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { sent: unknown[]; cenacleDesktop: unknown };
      w.sent = [];
      w.cenacleDesktop = {
        version: '1.0.0',
        platform: 'win32',
        titleBarHeight: 36,
        prefs: () => Promise.resolve(null),
        setBadge: () => Promise.resolve(),
        setTitleBar: () => Promise.resolve(),
        notify: (note: unknown) => {
          w.sent.push(note);
          return Promise.resolve();
        },
        onNotificationClick: () => () => {},
      };
    });
    const api = await mockApi(page, { channels: [OPS] });
    Object.assign(api.notifications!.prefs, defaults);
    await page.goto(`/c/${OPS.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ops');
    await away(page, true);
    api.emit('message.created', { ...mockMessage(93, 'Masaüstünden') });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { sent: unknown[] }).sent))
      .toEqual([{ title: 'Ayşe Yılmaz · General', body: 'Masaüstünden', channelId: GENERAL.id }]);
    expect((await state(page)).notes).toEqual([]);
  });
});
