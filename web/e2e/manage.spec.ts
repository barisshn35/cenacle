// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import {
  GENERAL,
  expectNoAxeViolations,
  expectTargetSizes,
  mockApi,
  mockMessage,
  showActions,
  PEOPLE,
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

  test("the channel's name opens its settings: details, members and roles, notifications", async ({
    page,
  }, testInfo) => {
    await mockApi(page, { admin: true });
    // A second member, whose role the manager changes.
    await page.route(`**/api/channels/${GENERAL.id}/members`, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: {
              members: [
                { user: PEOPLE[0], role: 'manager' },
                { user: PEOPLE[1], role: 'member' },
              ],
            },
          })
        : route.fallback(),
    );
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('heading', { level: 1 }).getByRole('button', { name: 'General' }).click();
    const settings = page.getByRole('dialog', { name: 'Channel settings' });
    await expect(settings.getByRole('tab')).toHaveText([
      'General',
      'Members and roles',
      'Notifications',
    ]);
    await expect(settings.getByLabel('Name')).toHaveValue('General');
    await settings.getByRole('tab', { name: 'Members and roles' }).click();
    const role = settings.getByLabel(`Role of ${PEOPLE[1]!.display_name} in this channel`);
    await expect(role).toHaveValue('member');
    const sent = page.waitForRequest(
      (r) => r.url().includes(`/api/channels/${GENERAL.id}/members/`) && r.method() === 'PATCH',
    );
    await role.selectOption('manager');
    expect((await sent).postDataJSON()).toEqual({ role: 'manager' });
    await settings.getByRole('tab', { name: 'Notifications' }).click();
    await expect(settings.getByRole('tabpanel')).toBeVisible();
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
  });

  test('someone who does not manage the channel sees its members and their notifications', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('heading', { level: 1 }).getByRole('button', { name: 'General' }).click();
    const settings = page.getByRole('dialog', { name: 'Channel settings' });
    await expect(settings.getByRole('tab')).toHaveText(['Members and roles', 'Notifications']);
    await expect(settings.getByRole('combobox', { name: /^Role of / })).toHaveCount(0);
  });

  test('call settings are in the workspace settings, not in the channel header', async ({
    page,
  }) => {
    await mockApi(page, { admin: true });
    await page.route('**/api/workspaces/*/calls/settings', (route) =>
      route.fulfill({
        json: {
          available: true,
          enabled: true,
          guest_start: false,
          max_participants: 8,
          max_bitrate: 2500000,
        },
      }),
    );
    await page.goto(`/c/${GENERAL.id}`);
    await expect(page.getByRole('button', { name: 'Call settings', exact: true })).toHaveCount(0);
    await page
      .getByRole('button', { name: /^Workspace menu: / })
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
    await dialog.getByRole('tab', { name: 'Calls', exact: true }).click();
    await expect(dialog.getByLabel('Allow calls in this workspace')).toBeChecked();
  });

  test('a manager archives a channel with confirmation and Undo', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto(`/c/${GENERAL.id}`);
    // General is a channel for everyone but not mandatory.
    await page.getByRole('button', { name: 'Channel settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Channel settings' });
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
    const settings = page.getByRole('dialog', { name: 'Channel settings' });
    await settings.getByLabel('Category').selectOption({ label: 'Mühendislik' });
    await settings.getByRole('button', { name: 'Save' }).click();
    const group = page.getByRole('navigation', { name: 'Channels' }).getByText('Mühendislik');
    await expect(group).toBeVisible();
  });

  test('a new category shows while empty; channels go in from its window or a menu', async ({
    page,
  }) => {
    const api = await mockApi(page, { admin: true });
    await page.goto(`/c/${GENERAL.id}`);
    const nav = page.getByRole('navigation', { name: 'Channels' });
    await page.getByRole('button', { name: 'Edit categories' }).click();
    const dialog = page.getByRole('dialog', { name: 'Categories' });
    await dialog.getByLabel('New category').fill('Destek');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByText('No channels yet.')).toBeVisible();
    await page.keyboard.press('Escape');
    // Empty, it is in the sidebar with a hint (it was hidden until it had a channel).
    await expect(nav.getByText('Destek')).toBeVisible();
    await expect(nav.getByText(/No channels yet\. Drag one here/)).toBeVisible();
    // From the window: add General, then take it out.
    await page.getByRole('button', { name: 'Edit categories' }).click();
    await dialog.getByLabel('Add a channel to Destek').selectOption({ label: 'General' });
    await expect
      .poll(() => api.channels!.find((c) => c.id === GENERAL.id)?.category_id)
      .toBeTruthy();
    await dialog.getByRole('button', { name: 'Take General out of Destek' }).click();
    await expect.poll(() => api.channels!.find((c) => c.id === GENERAL.id)?.category_id).toBe(null);
    await page.keyboard.press('Escape');
    // From the channel's menu in the sidebar, without dragging.
    await nav.getByRole('button', { name: 'General options' }).click();
    await page.getByRole('menuitem', { name: 'Category (everyone)' }).click();
    await page.getByRole('menuitem', { name: 'Destek' }).click();
    await expect
      .poll(() => api.channels!.find((c) => c.id === GENERAL.id)?.category_id)
      .toBeTruthy();
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

test('a channel name that fits is shown whole in the header', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/c/${GENERAL.id}`);
  const name = page.locator('#channel-title button span');
  await expect(name).toHaveText('General');
  // Not cut to "Gene…": the text fits in its box.
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
