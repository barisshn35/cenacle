// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { directWith, GENERAL, mockApi, mockMessage, PEOPLE } from './helpers';

const [, AYSE, MERT] = PEOPLE as [
  (typeof PEOPLE)[number],
  (typeof PEOPLE)[number],
  (typeof PEOPLE)[number],
];

test.describe('direct messages, unread, presence and typing', () => {
  test('starts a direct conversation from the sidebar', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sidebar is in the drawer on phones');
    await mockApi(page);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Channels' });
    await expect(nav.getByText('No conversations yet.')).toBeVisible();

    await nav.getByRole('button', { name: 'New conversation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New conversation' });
    await dialog.getByLabel('Find people').fill('mert');
    await dialog.getByRole('button', { name: 'Add Mert Kaya' }).click();
    await expect(dialog.getByRole('button', { name: 'Remove Mert Kaya' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Start conversation' }).click();

    await expect(page).toHaveURL(/\/c\/01a15e50-dddd-/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mert Kaya');
    await expect(nav.getByRole('link', { name: /Mert Kaya/ })).toBeVisible();
    await expect(
      page.getByText('This is the start of your conversation with Mert Kaya.'),
    ).toBeVisible();
  });

  test('Ctrl K finds people and conversations by name', async ({ page }) => {
    await mockApi(page, { channels: [directWith(AYSE)] });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: 'Jump to a channel or person' });
    // An existing conversation is found by the other person's name.
    await box.fill('ayşe');
    await expect(page.getByRole('option', { name: /Ayşe Yılmaz/ })).toHaveCount(1);
    // Someone without a conversation yet: picking them opens one.
    await box.fill('mert');
    await page.getByRole('option', { name: /Mert Kaya.*Direct message/ }).click();
    await expect(page).toHaveURL(/\/c\/01a15e50-dddd-/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mert Kaya');
  });

  test('shows unread counts and marks a conversation read when it is opened', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the sidebar is in the drawer on phones');
    const dm = directWith(MERT, { unread_count: 2, last_read_id: mockMessage(1, '').id });
    const messages = [1, 2, 3, 4].map((n) => ({
      ...mockMessage(n, `mesaj ${n}`, 'Mert Kaya'),
      channel_id: dm.id,
      author: { id: MERT.id, display_name: 'Mert Kaya' },
    }));
    const api = await mockApi(page, {
      channels: [dm],
      messages,
      general: { unread_count: 4 },
    });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Channels' });
    // A conversation shows a count; a channel is bold with a dot.
    const dmItem = nav.locator('li', { has: page.getByRole('link', { name: /Mert Kaya/ }) });
    await expect(dmItem.getByText('2', { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: /General.*4 unread messages/ })).toBeVisible();

    // Another message arrives (the fake server has stored it already).
    api.emit('message.created', {
      ...mockMessage(4, 'yeni', 'Mert Kaya'),
      channel_id: dm.id,
      author: { id: MERT.id, display_name: 'Mert Kaya' },
    });
    await expect(dmItem.getByText('3', { exact: true })).toBeVisible();

    await nav.getByRole('link', { name: /Mert Kaya/ }).click();
    // The line sits above the first message that was unread.
    const line = page.getByTestId('new-messages');
    await expect(line).toBeVisible();
    await expect(page.getByTestId('message').nth(1)).toContainText('mesaj 2');
    await expect.poll(() => api.reads.get(dm.id)).toBe(mockMessage(4, '').id);
    await expect(dmItem.getByText(/^\d+$/)).toHaveCount(0);
  });

  test('another device reading clears the count', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sidebar is in the drawer on phones');
    const dm = directWith(AYSE, { unread_count: 5 });
    const api = await mockApi(page, { channels: [dm] });
    await page.goto(`/c/${GENERAL.id}`);
    const nav = page.getByRole('navigation', { name: 'Channels' });
    const dmItem = nav.locator('li', { has: page.getByRole('link', { name: /Ayşe Yılmaz/ }) });
    await expect(dmItem.getByText('5', { exact: true })).toBeVisible();
    api.emit('channel.read', {
      user_id: PEOPLE[0]!.id,
      channel_id: dm.id,
      message_id: mockMessage(9, '').id,
    });
    await expect(dmItem.getByText('5', { exact: true })).toHaveCount(0);
  });

  test('shows who is typing and tells others while typing', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(`/c/${GENERAL.id}`);
    await expect(page.getByRole('textbox', { name: 'Message General' })).toBeVisible();

    api.emitEphemeral('typing', {
      channel_id: GENERAL.id,
      user_id: AYSE.id,
      display_name: 'Ayşe Yılmaz',
    });
    await expect(page.getByTestId('typing')).toHaveText('Ayşe Yılmaz is typing…');
    // Their message ends the notice.
    api.emit('message.created', {
      ...mockMessage(5, 'tamam'),
      author: { id: AYSE.id, display_name: 'Ayşe Yılmaz' },
    });
    await expect(page.getByTestId('typing')).toHaveText('');

    await page.getByRole('textbox', { name: 'Message General' }).pressSequentially('merhaba');
    await expect.poll(() => api.typing.length).toBe(1); // throttled
    expect(api.typing[0]).toBe(GENERAL.id);
  });

  test('shows presence and lets the user choose a status', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sidebar is in the drawer on phones');
    const api = await mockApi(page, {
      channels: [directWith(MERT)],
      presence: [
        { user_id: MERT.id, status: 'online' },
        { user_id: PEOPLE[0]!.id, status: 'online' },
      ],
    });
    await page.goto(`/c/${GENERAL.id}`);
    const nav = page.getByRole('navigation', { name: 'Channels' });
    await expect(nav.getByRole('link', { name: /Mert Kaya/ })).toContainText('Online');
    api.emitEphemeral('presence.changed', { user_id: MERT.id, status: 'away', workspace_ids: [] });
    await expect(nav.getByRole('link', { name: /Mert Kaya/ })).toContainText('Away');

    await page.getByRole('button', { name: /Status: Online/ }).click();
    await page.getByRole('menuitem', { name: 'Do not disturb' }).click();
    await expect.poll(() => api.statuses).toEqual(['dnd']);
    await expect(page.getByRole('button', { name: /Status: Do not disturb/ })).toBeVisible();
  });
});
