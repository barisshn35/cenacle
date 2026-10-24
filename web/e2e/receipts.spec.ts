// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { directWith, mockApi, mockMessage, PEOPLE, SESSION } from './helpers';

const MERT = PEOPLE[2]!;

test('read receipts show who has seen one’s last message', async ({ page }) => {
  const dm = directWith(MERT);
  const own = {
    ...mockMessage(1, 'Toplantı 3’te mi?'),
    channel_id: dm.id,
    author: { id: SESSION.user.id, display_name: SESSION.user.display_name },
  };
  const api = await mockApi(page, { channels: [dm], messages: [own], reads: [] });
  await page.goto(`/c/${dm.id}`);
  const message = page.getByTestId('message').filter({ hasText: 'Toplantı' });
  await expect(message).toBeVisible();
  await expect(page.getByTestId('seen-by')).toHaveCount(0);

  api.emit('conversation.read', { channel_id: dm.id, user_id: MERT.id, message_id: own.id });
  await expect(message.getByTestId('seen-by')).toHaveText('Seen');
});

test('no read receipts unless the workspace turned them on', async ({ page }) => {
  const dm = directWith(MERT);
  const own = {
    ...mockMessage(1, 'Merhaba'),
    channel_id: dm.id,
    author: { id: SESSION.user.id, display_name: SESSION.user.display_name },
  };
  const api = await mockApi(page, { channels: [dm], messages: [own] });
  await page.goto(`/c/${dm.id}`);
  await expect(page.getByTestId('message')).toBeVisible();
  api.emit('conversation.read', { channel_id: dm.id, user_id: MERT.id, message_id: own.id });
  await page.waitForTimeout(300);
  await expect(page.getByTestId('seen-by')).toHaveCount(0);
});
