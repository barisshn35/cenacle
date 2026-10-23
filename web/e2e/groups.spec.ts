// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  PEOPLE,
} from './helpers';

const AYSE = PEOPLE[1]!;

test('a group is created, managed and mentioned', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the workspace menu is in the drawer on phones');
  const api = await mockApi(page);
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
  await page.getByRole('menuitem', { name: 'Groups' }).click();
  const dialog = page.getByRole('dialog', { name: 'Groups' });
  await expect(dialog.getByText('You are not in any group yet.')).toBeVisible();

  await dialog.getByRole('button', { name: 'Create group' }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Backend ekibi');
  // The handle follows the name until it is typed.
  await expect(dialog.getByLabel('Handle')).toHaveValue('backend-ekibi');
  await dialog.getByLabel('Find people').fill('ayşe');
  await dialog.getByRole('button', { name: `Add ${AYSE.display_name}` }).click();
  await expect(dialog.getByRole('button', { name: `Remove ${AYSE.display_name}` })).toBeVisible();
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Create group' }).click();

  // It opens with its people; the creator manages it.
  await expect(dialog.getByRole('heading', { name: '@backend-ekibi' })).toBeVisible();
  await expect(dialog.getByText(AYSE.display_name)).toBeVisible();
  await dialog.getByRole('button', { name: `Make ${AYSE.display_name} a manager` }).click();
  await expect.poll(() => api.groups[0]!.members[1]!.manager).toBe(true);
  await dialog.getByRole('button', { name: 'Back to groups' }).click();
  await expect(dialog.getByRole('button', { name: /@backend-ekibi/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // The composer suggests it after "@".
  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.fill('@back');
  await page.getByRole('option', { name: /@backend-ekibi/ }).click();
  await expect(box).toHaveValue('@backend-ekibi ');

  // A message mentioning it marks the group, and reaches the reader in it.
  api.emit('message.created', {
    ...mockMessage(1, '@backend-ekibi bakar mısınız?'),
    channel_id: GENERAL.id,
  });
  const message = page.getByTestId('message').filter({ hasText: 'bakar mısınız' });
  await expect(message.getByTestId('mention')).toHaveText('@backend-ekibi');
  await expect(message).toHaveAttribute('data-mentions-me', 'true');
});
