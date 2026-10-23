// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { CENTRAL, expectNoAxeViolations, expectTargetSizes, GENERAL, mockApi } from './helpers';

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, 'keyboard shortcuts are for keyboards');
});

test('Ctrl+/ lists the shortcuts', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/c/${GENERAL.id}`);
  await page.keyboard.press('Control+/');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog.getByText('Edit your last message (empty message box)')).toBeVisible();
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await page.keyboard.press('Control+/');
  await expect(dialog).toBeHidden();
});

test('Alt+arrows move between channels', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/c/${CENTRAL.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Central');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page).toHaveURL(new RegExp(GENERAL.id));
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page).toHaveURL(new RegExp(CENTRAL.id));
});

test('the message box: ↑ edits the last message, Ctrl+B makes text bold', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto(`/c/${GENERAL.id}`);
  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.fill('kendi mesajım');
  await box.press('Enter');
  await expect.poll(() => api.sent.length).toBe(1);
  await expect(page.getByTestId('message').filter({ hasText: 'kendi mesajım' })).toBeVisible();

  await box.press('ArrowUp');
  const editor = page.getByLabel('Edit message');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('kendi mesajım');
  await editor.press('Escape');

  await box.fill('çok önemli');
  await box.press('Control+a');
  await box.press('Control+b');
  await expect(box).toHaveValue('**çok önemli**');
});
