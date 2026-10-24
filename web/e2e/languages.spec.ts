// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { DEFAULT_WS, expectNoAxeViolations, expectTargetSizes, GENERAL, mockApi } from './helpers';
import ar from '../src/i18n/ar.json' with { type: 'json' };

test.describe('languages', () => {
  test.skip(({ isMobile }) => isMobile, 'Settings is on the desktop rail');

  test('Arabic lays the app out right to left', async ({ page }, testInfo) => {
    await mockApi(page);
    await page.goto(`/c/${GENERAL.id}`);
    await page
      .getByRole('navigation', { name: 'Workspaces' })
      .getByRole('button', { name: 'Settings' })
      .click();
    await page.getByRole('tab', { name: 'Language' }).click();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('ar');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'ar');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await page.keyboard.press('Escape');
    const rail = page.getByRole('navigation', { name: ar.glossary.workspaces });
    await expect(rail).toBeVisible();
    // The rail is on the right in a right-to-left layout.
    const box = (await rail.boundingBox())!;
    expect(box.x).toBeGreaterThan((page.viewportSize()!.width * 2) / 3);
    await expectTargetSizes(page, testInfo);
    await expectNoAxeViolations(page);

    // Back to German: left to right again, and it stays after a reload.
    await page.evaluate(() => localStorage.setItem('cenacle.language', 'de'));
    await page.reload();
    await expect(html).toHaveAttribute('lang', 'de');
    await expect(html).toHaveAttribute('dir', 'ltr');
  });
});

test('search finds canvases, list rows and files by their text', async ({ page }, testInfo) => {
  await mockApi(page);
  const channel = { id: GENERAL.id, name: 'General', kind: 'standard', workspace_id: DEFAULT_WS };
  await page.route('**/api/search/content?**', (route) =>
    route.fulfill({
      json: {
        canvases: [
          {
            tab_id: '01a16600-0000-7000-8000-0000000000a1',
            title: 'Yol haritası',
            channel,
            excerpt: 'Üçüncü çeyrekte «masaüstü» uygulaması.',
            updated_at: '2026-10-24T10:00:00Z',
          },
        ],
        items: [
          {
            id: '01a16600-0000-7000-8000-0000000000b1',
            title: 'Masaüstü imzalama sertifikası',
            tab_id: '01a16600-0000-7000-8000-0000000000b2',
            list_title: 'Görevler',
            channel,
            updated_at: '2026-10-24T10:00:00Z',
          },
        ],
      },
    }),
  );
  await page.route('**/api/search/files?**', (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: '01a16600-0000-7000-8000-0000000000c1',
            channel,
            message_id: '01a16600-0000-7000-8000-0000000000c2',
            name: 'notlar.pdf',
            content_type: 'application/pdf',
            size: 2048,
            has_thumbnail: false,
            created_at: '2026-10-24T10:00:00Z',
            uploader: { id: '01a16600-0000-7000-8000-0000000000c3', display_name: 'Ayşe' },
            excerpt: 'Yeni «masaüstü» sürümü',
          },
        ],
        has_more: false,
      },
    }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Search messages and files' }).click();
  const panel = page.getByTestId('search-panel');
  await panel.getByRole('searchbox', { name: 'Search for' }).fill('masaüstü');
  await panel.getByRole('tab', { name: 'Files' }).click();
  await expect(panel.getByTestId('search-file-excerpt').locator('mark')).toHaveText('masaüstü');
  await panel.getByRole('tab', { name: 'Canvases and lists' }).click();
  await expect(panel.getByTestId('search-canvases').locator('mark')).toHaveText('masaüstü');
  await expect(panel.getByTestId('search-items')).toContainText('Görevler');
  await expectNoAxeViolations(page, '[data-testid="search-panel"]');
  await expectTargetSizes(page, testInfo, '[data-testid="search-panel"]');
  await panel.getByTestId('search-canvases').getByRole('button').click();
  await expect(page).toHaveURL(/tab=01a16600-0000-7000-8000-0000000000a1/);
});
