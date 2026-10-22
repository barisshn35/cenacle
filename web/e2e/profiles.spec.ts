// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  PEOPLE,
  SESSION,
} from './helpers';

const AYSE = PEOPLE[1]!;

function fromAyse() {
  const m = mockMessage(1, 'Merhaba');
  m.author = { id: AYSE.id, display_name: AYSE.display_name };
  return m;
}

test.describe('profiles', () => {
  test.skip(({ isMobile }) => isMobile, 'the sidebar footer is in the drawer on phones');

  test('a name opens the person’s card, with a way to message them', async ({ page }, testInfo) => {
    const api = await mockApi(page, { messages: [fromAyse()] });
    api.profiles[AYSE.id]!.status = { emoji: '🌴', text: 'On holiday' };
    api.profiles[AYSE.id]!.last_seen_at = new Date(Date.now() - 3 * 3600_000).toISOString();
    await page.goto(`/c/${GENERAL.id}`);
    // The custom status is next to the name in the message.
    const message = page.getByTestId('message').first();
    await expect(message.getByTestId('person-status')).toHaveText(/🌴/);

    await message.getByRole('button', { name: 'Ayşe Yılmaz' }).click();
    const card = page.getByTestId('profile-card');
    await expect(card).toContainText('@ayse');
    await expect(card.getByTestId('custom-status')).toContainText('On holiday');
    await expect(card).toContainText('last seen 3 hours ago');
    await expect(card).toContainText(/GMT\+3/);
    await expectTargetSizes(page, testInfo, '[data-testid="profile-card"]');
    await expectNoAxeViolations(page, '[data-testid="profile-card"]');

    await card.getByRole('button', { name: 'Message' }).click();
    await expect(page).toHaveURL(/\/c\/01a15e50-dddd/);
  });

  test('setting a custom status and editing the profile', async ({ page }, testInfo) => {
    await mockApi(page);
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: /^Status: / }).click();
    await page.getByRole('menuitem', { name: 'Set a custom status' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set a custom status' });
    await dialog.getByRole('button', { name: /In a meeting/ }).click();
    await expect(dialog.getByLabel('What are you up to?')).toHaveValue('In a meeting');
    await expect(dialog.getByLabel('Clear after')).toHaveValue('1h');
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('custom-status').first()).toContainText('In a meeting');

    await page.getByRole('button', { name: /^Status: / }).click();
    await page.getByRole('menuitem', { name: 'Edit profile' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit profile' });
    await expect(edit.getByLabel('Name', { exact: true })).toHaveValue(SESSION.user.display_name);
    await edit.getByLabel('Username').fill('deniz.k');
    await edit.locator('input[type="file"]').setInputFiles({
      name: 'me.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(edit.getByRole('button', { name: 'Remove picture' })).toBeVisible();
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toHaveCount(0);
  });

  test('workspace admins describe the workspace and give it an icon', async ({ page }) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
    const details = page.getByRole('dialog').getByTestId('workspace-details');
    await details.getByLabel('Description (optional)').fill('Everyone at the company');
    await details.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(details.getByRole('button', { name: 'Upload an icon' })).toBeVisible();
  });
});
