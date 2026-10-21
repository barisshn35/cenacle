// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { trackExternalRequests, mockSession } from './helpers';

// The app needs a session; the chat server is not running in these tests.
test.beforeEach(({ page }) => mockSession(page));

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

test('brand icons and manifest are served from our origin', async ({ page, request }) => {
  await page.goto('/');
  const icons = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) => links.map((l) => (l as HTMLLinkElement).getAttribute('href')));
  expect(icons).toEqual(
    expect.arrayContaining([
      '/favicon.ico',
      '/favicon.svg',
      '/favicon-dark.svg',
      '/apple-touch-icon.png',
    ]),
  );
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({
    name: 'Cenacle',
    theme_color: '#14342B',
    background_color: '#0C1A16',
  });
  for (const href of [...icons, ...manifest.icons.map((i: { src: string }) => i.src)]) {
    const res = await request.get(href!);
    expect(res.status(), href!).toBe(200);
  }
});

test('the favicon follows the system theme', async ({ page }) => {
  // Samples the arch stroke of /favicon.svg drawn at 64 px.
  const archColor = async () =>
    page.evaluate(async () => {
      const img = new Image(64, 64);
      img.src = `/favicon.svg?t=${Math.random()}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, 64, 64);
      // Left leg of the arch: x = 10, y = 32 in the 2.25..45.75 viewBox.
      const [r, g, b] = ctx.getImageData(11, 43, 1, 1).data;
      return [r, g, b];
    });
  await page.goto('/');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await archColor()).toEqual([0x14, 0x34, 0x2b]); // Forest
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await archColor()).toEqual([0xf3, 0xee, 0xe2]); // Bone
});
