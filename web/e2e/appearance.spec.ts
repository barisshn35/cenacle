// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectTargetSizes, GENERAL, mockApi } from './helpers';

test.describe('appearance', () => {
  test.skip(({ isMobile }) => isMobile, 'settings open from the sidebar footer on desktop');

  test('theme preset, fonts and code blocks follow the settings', async ({ page }, testInfo) => {
    await mockApi(page, {
      messages: [],
    });
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Appearance' }).click();
    const panel = dialog.getByTestId('appearance-panel');

    await panel.getByRole('radio', { name: 'Ocean' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'ocean');
    await panel.getByLabel('Fonts', { exact: true }).selectOption('classic');
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--font-sans'),
        ),
      )
      .toContain('IBM Plex Sans');
    await panel.getByLabel('Text size').selectOption('16');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.fontSize))
      .not.toBe('');
    await panel.getByLabel('Show line numbers').click();
    await expect(panel.getByLabel('Show line numbers')).toBeChecked();
    await expect(panel.getByTestId('appearance-preview').locator('pre')).toHaveAttribute(
      'data-line-numbers',
      'true',
    );
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');

    // The choice survives a reload (saved, and cached for the first paint).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'ocean');

    // Back to the workspace's preset: Cenacle's own colors.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Appearance' }).click();
    await panel.getByRole('radio', { name: "Workspace's" }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-preset', /.+/);
  });

  test('a custom theme is made from picked colors and stays readable', async ({
    page,
  }, testInfo) => {
    await mockApi(page);
    const saved: unknown[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/api/me/appearance'))
        saved.push(r.postDataJSON());
    });
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Appearance' }).click();
    const panel = dialog.getByTestId('appearance-panel');
    await panel.getByRole('radio', { name: 'Custom' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'custom');
    const editor = panel.getByTestId('custom-theme-editor');
    const brand = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent-brand').trim(),
      );
    await expect.poll(brand).toBe('#8f6b1f');

    // A very light accent is made darker so that links stay readable.
    await editor.getByRole('textbox', { name: 'Accent', exact: true }).fill('#ffe066');
    await expect.poll(brand).not.toBe('#8f6b1f');
    expect(await brand()).not.toBe('#ffe066');
    await editor.getByRole('textbox', { name: 'Sidebar', exact: true }).fill('#0f1f3a');
    await editor.getByRole('radio', { name: 'Round', exact: true }).click();
    await expect
      .poll(() => saved.at(-1))
      .toMatchObject({
        preset: 'custom',
        custom_theme: { accent: '#ffe066', sidebar: '#0f1f3a', radius: 'round' },
      });
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--sidebar').trim(),
        ),
      )
      .toBe('#0f1f3a');
    await expect(editor.getByTestId('custom-theme-preview').locator('figure')).toHaveCount(2);
    await expectTargetSizes(page, testInfo, '[data-testid="custom-theme-editor"]');
    await expectNoAxeViolations(page, '[role="dialog"]');

    // Kept for the first paint after a reload.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'custom');
    await expect.poll(() => page.locator('#cenacle-custom-theme').count()).toBe(1);
  });

  test('a font of one’s own is uploaded and listed', async ({ page }) => {
    await mockApi(page);
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Appearance' }).click();
    const uploads = dialog.getByTestId('font-uploads');
    await uploads.getByLabel('Name (optional)').fill('House Sans');
    await uploads.locator('input[type="file"]').setInputFiles({
      name: 'house.woff2',
      mimeType: 'font/woff2',
      buffer: Buffer.from('wOF2-test-font'),
    });
    await expect(uploads.getByRole('button', { name: 'Remove House Sans' })).toBeVisible();
  });

  test('administrators replace interface texts', async ({ page }) => {
    await mockApi(page, { admin: true });
    await page.goto(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Interface texts' }).click();
    const panel = dialog.getByTestId('ui-texts-panel');
    await panel.getByLabel('Message box placeholder').fill('Write to {{channel}}');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('The texts are saved.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Write to General' })).toBeVisible();
  });

  test('workspace admins set the default appearance', async ({ page }) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
    const section = page.getByRole('dialog').getByTestId('workspace-appearance');
    await section.getByLabel('Theme').selectOption('forest');
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'forest');
    // A brand of its own: the colors are picked under the presets.
    await section.getByLabel('Theme').selectOption('custom');
    await expect(page.locator('html')).toHaveAttribute('data-preset', 'custom');
    await section.getByRole('textbox', { name: 'Accent', exact: true }).fill('#0b5cad');
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--accent-brand').trim(),
        ),
      )
      .toBe('#0b5cad');
  });
});
