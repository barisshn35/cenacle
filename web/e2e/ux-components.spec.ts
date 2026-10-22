// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test.describe('UX foundation components', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/gallery');
    await page.getByRole('heading', { level: 1 }).waitFor();
  });

  test('S2 confirm: keyboard only, safe default, Esc cancels', async ({ page }) => {
    const trigger = page.getByTestId('confirm-s2-trigger');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('alertdialog', { name: /Archive ops-alerts/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    // Enter on the default focus cancels.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Confirm with the keyboard: Tab to the action, Enter.
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    const action = dialog.getByRole('button', { name: /Archive channel/ });
    await expect(action).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(action).toBeDisabled();
    await expect(dialog).toHaveAttribute('aria-busy', 'true');
    await expect(dialog).toBeHidden();

    // The follow-up undo toast is announced politely and does not take focus.
    const toast = page.locator('[data-slot="undo-toast"]');
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toContainText('ops-alerts archived.');
    await expect(toast).not.toBeFocused();
  });

  test('S3 confirm requires typing the name', async ({ page }) => {
    await page.getByTestId('confirm-s3-trigger').click();
    const dialog = page.getByRole('alertdialog', { name: /Delete ops-alerts permanently/ });
    const action = dialog.getByRole('button', { name: /Delete channel/ });
    const input = dialog.getByLabel('To confirm, type ops-alerts');

    await expect(action).toBeDisabled();
    await input.fill('ops-alert');
    await expect(action).toBeDisabled();
    await input.press('Enter');
    await expect(dialog).toBeVisible();

    await input.fill('ops-alerts');
    await expect(action).toBeEnabled();
    await action.click();
    await expect(dialog).toBeHidden();
  });

  test('undo toast: keyboard reachable, keeps focus, at most two', async ({ page }) => {
    const trigger = page.getByTestId('undo-toast-trigger');
    await trigger.click();
    await trigger.click();
    await trigger.click();

    await expect(trigger).toBeFocused();
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toHaveCount(2);

    // Sonner's hotkey (Alt+T) moves focus into the toast region; Tab reaches Undo.
    await page.keyboard.press('Alt+t');
    const undo = page.getByRole('button', { name: 'Undo' }).first();
    for (let i = 0; i < 4 && !(await undo.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(undo).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Message restored.')).toBeVisible();
  });

  test('undo toast stays at least 10 seconds', async ({ page }) => {
    await page.clock.install();
    await page.getByTestId('undo-toast-trigger').click();
    const toast = page.locator('[data-slot="undo-toast"]');
    await expect(toast).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.runFor(9_500);
    await expect(toast).toBeVisible();
  });

  test('error states expose alert and status roles with request IDs', async ({ page }) => {
    const errors = page.locator('[data-slot="error-state"]');
    await expect(errors.nth(0)).toHaveAttribute('role', 'alert');
    await expect(errors.nth(0)).toContainText('REQ-8F3A2KQ7');
    await expect(errors.nth(1)).toHaveAttribute('role', 'status');
    await expect(errors.nth(1)).toContainText('Try again in 30 seconds.');
    await expect(page.locator('[data-slot="inline-error"]').last()).toHaveAttribute(
      'role',
      'alert',
    );
  });
});
