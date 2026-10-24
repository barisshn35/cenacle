// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, GENERAL, mockApi, mockMessage } from './helpers';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const image = (n: number) => ({
  id: `01a15e50-f11e-7000-8000-00000000010${n}`,
  name: `foto-${n}.png`,
  content_type: 'image/png',
  size: 90_000,
  width: 800,
  height: 600,
  has_thumbnail: true,
});

test('several images show as one gallery', async ({ page }) => {
  const message = { ...mockMessage(1, 'Etkinlikten'), files: [1, 2, 3, 4, 5].map(image) };
  await mockApi(page, { messages: [message] });
  await page.route(/\/api\/files\/[0-9a-f-]{36}\/(content|thumbnail)/, (route) =>
    route.fulfill({ body: PNG, contentType: 'image/png' }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  const gallery = page.getByRole('list', { name: '5 images' });
  await expect(gallery.getByTestId('image')).toHaveCount(4);
  const last = gallery.getByRole('button', { name: 'Open foto-4.png and 1 more image' });
  await expect(last).toContainText('+1');
  await expectNoAxeViolations(page, '[data-testid="gallery"]');
  await last.click();
  await expect(page.getByRole('dialog')).toContainText('foto-4.png');
});

test('the formatting bar writes Markdown and previews the message', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/c/${GENERAL.id}`);
  const box = page.getByRole('textbox', { name: 'Message General' });
  await page.getByRole('button', { name: 'Show formatting' }).click();
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await box.fill('çok önemli');
  await box.press('Control+a');
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect(box).toHaveValue('**çok önemli**');
  await bar.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('composer-preview').locator('strong')).toHaveText('çok önemli');
  await expect(box).toBeHidden();
  await bar.getByRole('button', { name: 'Preview' }).click();
  await expect(box).toBeVisible();
  // It stays shown next time.
  await page.reload();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
});
