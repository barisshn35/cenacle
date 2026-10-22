// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  RANDOM,
} from './helpers';

test.describe('notifications', () => {
  test.skip(({ isMobile }) => isMobile, 'settings open from the sidebar footer on desktop');

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

    await result.click();
    await expect(page).toHaveURL(new RegExp(`/c/${GENERAL.id}`));
    const target = page.locator(`[data-message-id="${messages[4]!.id}"]`);
    await expect(target).toBeInViewport();
    await expect(target).toHaveAttribute('data-highlighted', 'true');
    await expect(target).not.toHaveAttribute('data-highlighted', 'true', { timeout: 5000 });
  });

  test('says when nothing matches', async ({ page }) => {
    await mockApi(page, { messages: [mockMessage(1, 'Hello')] });
    await page.goto(`/c/${GENERAL.id}`);
    await page.keyboard.press('ControlOrMeta+Shift+F');
    const panel = page.getByTestId('search-panel');
    await panel.getByRole('searchbox', { name: 'Search for' }).fill('nothing');
    await expect(panel.getByText('No messages found. Try fewer or other words.')).toBeVisible();
  });
});
