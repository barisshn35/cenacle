// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { VARIANTS, expectNoAxeViolations, expectTargetSizes, isCoarse, mockApi } from './helpers';

// The app needs a session and the chat API; the chat server is not running in these tests.
test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test.describe('target size (WCAG 2.5.8 / project rule)', () => {
  test('pointer emulation matches the project', async ({ page }, testInfo) => {
    await page.goto('/dev/gallery');
    expect(await isCoarse(page)).toBe(testInfo.project.name === 'coarse');
  });

  for (const v of VARIANTS) {
    test(`gallery ${v.theme}/${v.density}`, async ({ page }, testInfo) => {
      await page.goto(`/dev/gallery?theme=${v.theme}&density=${v.density}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', v.theme);
      await expect(page.locator('html')).toHaveAttribute('data-density', v.density);
      await page.getByRole('heading', { level: 1 }).waitFor();

      const count = await expectTargetSizes(page, testInfo);
      expect(count).toBeGreaterThan(20);
      await expectNoAxeViolations(page);
    });
  }

  test('confirm dialogs and undo toast', async ({ page }, testInfo) => {
    await page.goto('/dev/gallery');
    for (const id of ['confirm-s2-trigger', 'confirm-s3-trigger']) {
      await page.getByTestId(id).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await expectTargetSizes(page, testInfo, '[role="alertdialog"]');
      await expectNoAxeViolations(page, '[role="alertdialog"]');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }

    await page.getByTestId('undo-toast-trigger').click();
    await expect(page.locator('[data-slot="undo-toast"]')).toBeVisible();
    await expectTargetSizes(page, testInfo, '[data-slot="undo-toast"]');
  });

  test('application shell', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.getByRole('heading', { level: 1 }).waitFor();
    await expectTargetSizes(page, testInfo);
    await expectNoAxeViolations(page);
  });
});
