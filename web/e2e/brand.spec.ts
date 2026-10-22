// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { mockApi } from './helpers';

// The app needs a session and the chat API; the chat server is not running in these tests.
test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`brand tokens meet their contrast thresholds (${theme})`, async ({ page }) => {
    await page.goto(`/dev/gallery?theme=${theme}&density=comfortable`);
    const rows = page.getByTestId('contrast-table').locator('tr');
    await expect(rows).toHaveCount(6);
    for (const row of await rows.all()) {
      const cell = row.locator('[data-ratio]');
      await expect(cell).not.toHaveAttribute('data-ratio', '');
      const ratio = Number(await cell.getAttribute('data-ratio'));
      const min = Number(/needs ([\d.]+)/.exec((await cell.textContent()) ?? '')?.[1]);
      expect(ratio, (await row.textContent()) ?? '').toBeGreaterThanOrEqual(min);
    }
  });
}

test('the speech bubble stays visible in the 16 px favicon', async ({ page }) => {
  await page.goto('/');
  const center = await page.evaluate(async () => {
    const img = new Image(16, 16);
    img.src = '/brand/favicon-16-light.svg';
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, 16, 16);
    // Bubble centre (24, 26.5) in the 2.25..45.75 viewBox -> about (8, 8.7) at 16 px.
    return [...ctx.getImageData(8, 8, 1, 1).data];
  });
  const [r, g, b, a] = center;
  expect(a).toBe(255);
  // Brass #C9A24B, allowing for anti-aliasing at this size.
  expect(Math.abs(r! - 0xc9) + Math.abs(g! - 0xa2) + Math.abs(b! - 0x4b)).toBeLessThan(40);
});
