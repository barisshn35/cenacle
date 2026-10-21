// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { GENERAL, expectNoAxeViolations, expectTargetSizes, mockApi, mockMessage } from './helpers';

const composer = (page: import('@playwright/test').Page) => page.getByLabel('Message #general');

test('the home page opens #general with its history', async ({ page, isMobile }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await mockApi(page, {
    messages: [
      mockMessage(1, 'Günaydın!'),
      mockMessage(2, 'Deploy tamam.'),
      mockMessage(30, 'Öğlen?', 'Mert Kaya'),
    ],
  });
  await page.goto('/');
  await expect(page).toHaveURL(`/c/${GENERAL.id}`);
  const log = page.getByRole('log', { name: 'Messages in #general' });
  await expect(log.getByTestId('message')).toHaveCount(3);
  await expect(log.getByText('Deploy tamam.')).toBeVisible();
  // Consecutive messages of one author share one visible header (screen
  // readers still get the author of every message).
  const headers = log.locator('header:not(.sr-only)');
  await expect(headers.filter({ hasText: 'Ayşe Yılmaz' })).toHaveCount(1);
  await expect(headers.filter({ hasText: 'Mert Kaya' })).toHaveCount(1);
  await expect(log.getByRole('article', { name: 'Ayşe Yılmaz' })).toHaveCount(2);
  if (!isMobile) {
    // On phones the channel list is in the drawer.
    await expect(page.getByRole('link', { name: /general/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
  // React reports problems such as duplicate keys as console errors.
  expect(errors).toEqual([]);
});

test('sending shows the message at once and confirms it', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await composer(page).fill('İlk mesaj\nikinci satır');
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByTestId('message').filter({ hasText: 'İlk mesaj' })).toBeVisible();
  await expect(page.getByTestId('pending-message')).toHaveCount(0);
  expect(api.sent).toEqual([{ body: 'İlk mesaj\nikinci satır', nonce: expect.any(String) }]);

  // Shift+Enter adds a line; empty input does not send.
  await composer(page).press('Shift+Enter');
  await composer(page).press('Enter');
  expect(api.sent).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('messages from others arrive live and are not duplicated', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('This is the start of #general.')).toBeVisible();
  const incoming = mockMessage(5, 'Canlı geldi', 'Mert Kaya');
  api.emit('message.created', incoming);
  api.emit('message.created', incoming); // delivered twice: shown once
  await expect(page.getByTestId('message').filter({ hasText: 'Canlı geldi' })).toHaveCount(1);
});

test('a message that could not be sent can be retried with the same nonce', async ({ page }) => {
  const api = await mockApi(page, { failSend: 1 });
  await page.goto('/');
  await composer(page).fill('Tekrar denenecek');
  await composer(page).press('Enter');
  const pending = page.getByTestId('pending-message');
  await expect(pending.getByRole('alert')).toContainText('Not sent');
  await expect(pending).toContainText('Tekrar denenecek');
  await pending.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('message').filter({ hasText: 'Tekrar denenecek' })).toBeVisible();
  await expect(pending).toHaveCount(0);
  expect(api.sent).toHaveLength(1);
});

test('drafts survive a reload', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await composer(page).fill('yarım kalan düşünce');
  await page.waitForTimeout(600); // drafts are saved shortly after typing stops
  await page.reload();
  await expect(composer(page)).toHaveValue('yarım kalan düşünce');
});

test('chat view: target size and axe with messages and a failed send', async ({
  page,
}, testInfo) => {
  await mockApi(page, {
    messages: [mockMessage(1, 'Merhaba'), mockMessage(9, 'Selam', 'Mert Kaya')],
    failSend: 1,
  });
  await page.goto('/');
  await composer(page).fill('olmadı');
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectTargetSizes(page, testInfo);
  await expectNoAxeViolations(page);
});
