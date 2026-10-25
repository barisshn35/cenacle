// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { GENERAL, mockApi, mockMessage, SESSION } from './helpers';

test('an empty channel follows the messages that keep arriving', async ({ page }) => {
  test.setTimeout(60_000);
  const api = await mockApi(page, { messages: [] });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('This is the start of General.')).toBeVisible();
  for (let n = 1; n <= 30; n++) {
    api.emit('message.created', { ...mockMessage(100 + n, `Arriving message ${n}`, 'Mert Kaya') });
    await page.waitForTimeout(100);
  }
  // The newest stays in view: the list follows while the reader is at its end.
  await expect(page.getByTestId('message').getByText('Arriving message 30')).toBeInViewport({
    timeout: 15_000,
  });
});

test("an empty channel follows one's own messages sent elsewhere", async ({ page }) => {
  test.setTimeout(60_000);
  const api = await mockApi(page, { messages: [] });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('This is the start of General.')).toBeVisible();
  for (let n = 1; n <= 30; n++) {
    const m = mockMessage(200 + n, `Own message ${n}`);
    api.emit('message.created', {
      ...m,
      author: { id: SESSION.user.id, display_name: SESSION.user.display_name },
      created_at: new Date().toISOString(),
    });
    await page.waitForTimeout(100);
  }
  await expect(page.getByText('Own message 30')).toBeInViewport({ timeout: 15_000 });
});
