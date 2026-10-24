// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectTargetSizes, GENERAL, mockApi } from './helpers';

test.describe('permission schemes', () => {
  test.skip(({ isMobile }) => isMobile, 'workspace settings open from the sidebar on wide screens');

  test('the owner lets members create channels', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Workspace settings' });
    await settings.getByRole('tab', { name: 'Permissions' }).click();
    const sent = page.waitForRequest(
      (r) => r.url().endsWith('/permissions') && r.method() === 'PUT',
    );
    await settings.getByLabel('Member: Create channels').check();
    const body = (await sent).postDataJSON() as { permissions: Record<string, string[]> };
    expect(body.permissions.create_channels).toEqual(['admin', 'member']);
    expect(body.permissions.invite_people).toEqual(['admin']);
    await expect(settings.getByLabel('Member: Create channels')).toBeChecked();
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
  });

  test('a member sees what the scheme gives their role', async ({ page }) => {
    await mockApi(page, { can: ['create_channels'] });
    await page.goto(`/c/${GENERAL.id}`);
    await expect(page.getByRole('button', { name: 'Create a channel' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await expect(page.getByRole('menuitem', { name: 'Invite people' })).toHaveCount(0);
  });

  test('a channel leaves reactions to its managers', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Channel settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings of General' });
    const moderation = settings.getByTestId('channel-moderation');
    await moderation.getByLabel('React').selectOption('managers');
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    const sent = page.waitForRequest(
      (r) => r.url().endsWith(`/api/channels/${GENERAL.id}`) && r.method() === 'PATCH',
    );
    await settings.getByRole('button', { name: 'Save' }).click();
    const body = (await sent).postDataJSON() as { moderation: Record<string, string> };
    expect(body.moderation).toEqual({
      post: 'everyone',
      reply: 'everyone',
      react: 'managers',
      broadcast: 'everyone',
    });
  });
});
