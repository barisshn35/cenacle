// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import {
  GENERAL,
  expectNoAxeViolations,
  expectTargetSizes,
  mockApi,
  mockMessage,
  showActions,
} from './helpers';

const composer = (page: Page) => page.getByLabel('Message General');

async function sendOwn(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  const msg = page.getByTestId('message').filter({ hasText: text });
  await expect(msg).toBeVisible();
  return msg;
}

test('authors edit their messages in place', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const msg = await sendOwn(page, 'yazım hatsı');
  await msg.hover();
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const editor = page.getByLabel('Edit message');
  await expect(editor).toBeFocused();
  await editor.fill('yazım hatası');
  await editor.press('Enter');
  await expect(page.getByTestId('message').filter({ hasText: 'yazım hatası' })).toContainText(
    '(edited)',
  );

  // Escape cancels.
  const edited = page.getByTestId('message').filter({ hasText: 'yazım hatası' });
  await edited.hover();
  await showActions(edited);
  await edited.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByLabel('Edit message').fill('vazgeçilen');
  await page.getByLabel('Edit message').press('Escape');
  await expect(page.getByText('vazgeçilen')).toHaveCount(0);

  // "(edited)" opens the earlier versions; one is put back.
  await edited.getByRole('button', { name: /^Edited .*Show the earlier versions$/ }).click();
  const history = page.getByRole('dialog', { name: 'Edit history' });
  await expect(history.getByText('yazım hatsı')).toBeVisible();
  await history.getByRole('button', { name: 'Restore this version' }).click();
  await expect(page.getByTestId('message').filter({ hasText: 'yazım hatsı' })).toBeVisible();
});

test('deleting shows Undo, which brings the message back', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const msg = await sendOwn(page, 'silinecek');
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByTestId('message').filter({ hasText: 'silinecek' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('message').filter({ hasText: 'silinecek' })).toBeVisible();
});

test('others’ messages cannot be edited or deleted by members', async ({ page }) => {
  await mockApi(page, { messages: [mockMessage(1, 'başkasının mesajı')] });
  await page.goto('/');
  const msg = page.getByTestId('message').filter({ hasText: 'başkasının mesajı' });
  await expect(msg).toBeVisible();
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Save for later' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Edit' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
});

test('live edits and deletions from others are applied', async ({ page }) => {
  const original = mockMessage(1, 'ilk');
  const api = await mockApi(page, { messages: [original] });
  await page.goto('/');
  await expect(page.getByText('ilk', { exact: true })).toBeVisible();
  api.emit('message.updated', { ...original, body: 'güncel', edited_at: new Date().toISOString() });
  await expect(page.getByTestId('message').filter({ hasText: 'güncel' })).toContainText('(edited)');
  api.emit('message.deleted', { id: original.id, channel_id: GENERAL.id });
  await expect(page.getByTestId('message')).toHaveCount(0);
});

test.describe('managing channels', () => {
  test.skip(({ isMobile }) => isMobile, 'sidebar actions are in the drawer on phones');

  test('a manager archives a channel with confirmation and Undo', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto(`/c/${GENERAL.id}`);
    // General is a channel for everyone but not mandatory.
    await page.getByRole('button', { name: 'Channel settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings of General' });
    await expect(settings.getByLabel('Visibility')).toBeDisabled();
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    await settings.getByRole('button', { name: 'Archive' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Archive General?' });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Archive channel' }).click();
    await expect(page.getByRole('link', { name: 'General' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('link', { name: 'General' })).toBeVisible();
  });

  test('the administrator groups channels in categories', async ({ page }) => {
    await mockApi(page, { admin: true });
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Edit categories' }).click();
    const dialog = page.getByRole('dialog', { name: 'Categories' });
    await dialog.getByLabel('New category').fill('Mühendislik');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByLabel('Name of Mühendislik')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Channel settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings of General' });
    await settings.getByLabel('Category').selectOption({ label: 'Mühendislik' });
    await settings.getByRole('button', { name: 'Save' }).click();
    const group = page.getByRole('navigation', { name: 'Channels' }).getByText('Mühendislik');
    await expect(group).toBeVisible();
  });
});

test('Ctrl+K jumps to a channel by typing part of its name', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await composer(page).waitFor();
  await page.keyboard.press('Control+k');
  const box = page.getByRole('combobox', { name: 'Jump to a channel or person' });
  await expect(box).toBeFocused();
  await box.fill('cent');
  await expect(page.getByRole('option')).toHaveCount(1);
  await box.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Central');
});
