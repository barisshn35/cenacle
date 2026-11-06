// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { composerTool, expectNoAxeViolations, GENERAL, mockApi, mockMessage } from './helpers';

test('an urgent message asks to be acknowledged', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto(`/c/${GENERAL.id}`);
  await composerTool(page, 'Priority');
  const popover = page.getByRole('dialog', { name: 'Priority' });
  await popover.getByLabel('Urgent').check();
  await popover.getByLabel('Ask to acknowledge').check();
  // Reminders need an urgent message (they are offered then).
  await expect(popover.getByLabel('Remind those mentioned')).toBeEnabled();
  await expectNoAxeViolations(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('priority-chip')).toContainText('Urgent · Ask to acknowledge');

  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.fill('Sunucu yanıt vermiyor');
  await box.press('Enter');
  await expect.poll(() => api.sent.at(-1)).toMatchObject({ priority: 'urgent', request_ack: true });
  const own = page.getByTestId('message').filter({ hasText: 'Sunucu yanıt vermiyor' });
  await expect(own.getByTestId('priority')).toHaveText('Urgent');
  await expect(own.getByTestId('ack')).toContainText('Nobody has acknowledged it yet.');
  await expect(page.getByTestId('priority-chip')).toHaveCount(0);
});

test('others acknowledge, and reminders come back', async ({ page }) => {
  const asking = {
    ...mockMessage(1, 'Bakım yarın 09:00'),
    priority: 'important',
    ack: { count: 0, me: false, people: [] },
  };
  const api = await mockApi(page, { messages: [asking] });
  await page.goto(`/c/${GENERAL.id}`);
  const message = page.getByTestId('message').filter({ hasText: 'Bakım yarın' });
  await expect(message.getByTestId('priority')).toHaveText('Important');
  await message.getByRole('button', { name: 'Acknowledge' }).click();
  await expect.poll(() => api.acks).toEqual([`PUT ${asking.id}`]);
  await expect(message.getByRole('button', { name: 'Acknowledged' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(message.getByTestId('ack')).toContainText('Acknowledged by Deniz Kaya');

  api.emit('message.reminder', {
    user_id: 'self',
    channel_id: GENERAL.id,
    message_id: asking.id,
    author_name: 'Ayşe Yılmaz',
    channel_name: 'General',
    channel_kind: 'standard',
    body: 'Bakım yarın 09:00',
  });
  await expect(page.getByText('Urgent message from Ayşe Yılmaz waits for you')).toBeVisible();
});
