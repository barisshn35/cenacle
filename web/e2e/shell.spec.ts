// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { trackExternalRequests } from './helpers';

test('no requests leave our origin (no CDN, fonts or telemetry)', async ({ page }) => {
  const external = trackExternalRequests(page);
  await page.goto('/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.goto('/dev/gallery');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.waitForLoadState('networkidle');
  expect(external).toEqual([]);
});

test('fonts are served locally', async ({ page }) => {
  const fonts: string[] = [];
  page.on('response', (r) => {
    if (r.request().resourceType() === 'font') fonts.push(r.url());
  });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px "Geist Variable"'))).toBe(true);
  for (const f of fonts) expect(new URL(f).hostname).toBe('127.0.0.1');
});

test.describe('appearance', () => {
  test.skip(({ isMobile }) => isMobile, 'selectors are in the desktop header');

  test('theme and density switch and persist', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await page.getByLabel('Theme').selectOption('dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('Density').selectOption('comfortable');
    await expect(html).toHaveAttribute('data-density', 'comfortable');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-density', 'comfortable');

    await page.getByLabel('Theme').selectOption('system');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('language switches to Turkish', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Language').selectOption('tr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page.getByRole('navigation', { name: 'Çalışma alanları' })).toBeVisible();
  });

  test('details panel opens and closes without dragging', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Channel details', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const main = page.getByRole('main');
    const before = (await main.boundingBox())!.width;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('complementary')).toBeHidden();
    await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThan(before + 100);
    await toggle.click();
    await expect(page.getByRole('complementary')).toBeVisible();
    await expect.poll(async () => (await main.boundingBox())!.width).toBeLessThan(before + 5);
  });
});

test('unknown route shows a not-found state', async ({ page }) => {
  await page.goto('/does-not-exist');
  await expect(page.getByRole('status')).toContainText("This page doesn't exist.");
});
