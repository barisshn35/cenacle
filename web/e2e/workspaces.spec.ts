// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { DEFAULT_WS, expectNoAxeViolations, expectTargetSizes, mockApi } from './helpers';

test.describe('workspaces', () => {
  test.skip(
    ({ isMobile }) => isMobile,
    'the rail and the sidebar header are in the desktop layout',
  );

  test('the rail lists the user’s workspaces and opens them', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    const rail = page.getByRole('navigation', { name: 'Workspaces' });
    await expect(rail.getByRole('link', { name: 'Cenacle' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await rail.getByRole('link', { name: 'Cenacle' }).click();
    await expect(page).toHaveURL(/\/c\//);
  });

  test('members see the member list but cannot invite', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await expect(page.getByRole('menuitem', { name: 'Invite people' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Leave workspace' })).toHaveCount(0); // default workspace
    await page.getByRole('menuitem', { name: 'Members' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('workspace-members')).toContainText('Ayşe Yılmaz');
    await expect(dialog.getByRole('combobox')).toHaveCount(0);
  });

  test('owners invite with a link and manage roles', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await page.getByRole('menuitem', { name: 'Invite people' }).click();
    const invite = page.getByRole('dialog', { name: 'Invite people to Cenacle' });
    await invite.getByLabel('Can be used').selectOption({ label: '10 times' });
    await invite.getByRole('button', { name: 'Create link' }).click();
    await expect(invite.getByLabel('Invitation link')).toHaveValue(/\/invite\/token1$/);
    await expect(invite.getByTestId('invites')).toContainText('used 0/10');
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Cenacle' });
    await expect(settings.getByLabel('Role of Ayşe Yılmaz')).toHaveValue('member');
    await expect(settings.getByLabel('Name')).toHaveValue('Cenacle');
  });

  test('admins map directory groups to the workspace', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
    const groups = page.getByRole('dialog').getByTestId('workspace-groups');
    await groups.getByLabel('Group', { exact: true }).fill('engineering');
    await groups.getByLabel('Role', { exact: true }).selectOption('admin');
    await groups.getByRole('button', { name: 'Add group' }).click();
    await expect(groups.getByLabel('Role of the group engineering')).toHaveValue('admin');
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    await groups.getByRole('button', { name: 'Remove the group engineering' }).click();
    await expect(groups.getByLabel('Role of the group engineering')).toHaveCount(0);
  });

  test('the instance administrator creates a workspace', async ({ page }) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Add a workspace' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a workspace' });
    await dialog.getByLabel('New workspace').fill('Operasyon');
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/w\//);
    await expect(
      page.getByRole('navigation', { name: 'Workspaces' }).getByRole('link', { name: 'Operasyon' }),
    ).toBeVisible();
  });
});

test('an invitation link leads to its workspace', async ({ page }) => {
  await mockApi(page);
  let accepted = false;
  await page.route('**/api/invites/abc123', (route) =>
    route.fulfill({
      json: {
        workspace_id: DEFAULT_WS,
        workspace_name: 'Operasyon',
        valid: true,
        is_member: false,
      },
    }),
  );
  await page.route('**/api/invites/abc123/accept', (route) => {
    accepted = true;
    return route.fulfill({
      json: { id: DEFAULT_WS, name: 'Operasyon', is_default: false, role: 'member' },
    });
  });
  await page.goto('/invite/abc123');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Join Operasyon');
  await page.getByRole('button', { name: 'Join Operasyon' }).click();
  await expect(page).toHaveURL(/\/c\//);
  expect(accepted).toBe(true);
});

test('an invalid invitation explains itself', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/invites/old', (route) =>
    route.fulfill({
      json: {
        workspace_id: DEFAULT_WS,
        workspace_name: 'Operasyon',
        valid: false,
        is_member: false,
      },
    }),
  );
  await page.goto('/invite/old');
  await expect(page.getByRole('alert')).toContainText('This invitation can no longer be used.');
});
