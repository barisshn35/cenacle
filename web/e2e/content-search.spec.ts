// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { DEFAULT_WS, expectNoAxeViolations, expectTargetSizes, GENERAL, mockApi } from './helpers';

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
  const box = panel.getByRole('searchbox', { name: 'Search for' });
  await box.fill('masaüstü');
  // The magnifier sits in the box, centred on it, not lower over the hint below.
  const icon = await panel.locator('svg.lucide-search').boundingBox();
  const field = await box.boundingBox();
  expect(Math.abs(icon!.y + icon!.height / 2 - (field!.y + field!.height / 2))).toBeLessThan(1.5);
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

test('the search panel says it is searching until the search starts', async ({ page }) => {
  await mockApi(page);
  let asked = 0;
  await page.route('**/api/search/messages?**', (route) => {
    asked++;
    return route.fulfill({ json: { results: [], has_more: false } });
  });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Search messages and files' }).click();
  const panel = page.getByTestId('search-panel');
  await expect(panel.getByText('Type to search your channels and conversations.')).toBeVisible();
  // The search waits for typing to stop; meanwhile the panel does not ask to type.
  // The clock is paused: an installed clock keeps running, and on a loaded
  // runner the wait ran out before the checks below.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await panel.getByRole('searchbox', { name: 'Search for' }).fill('masaüstü');
  await expect(panel.getByText('Searching…')).toBeVisible();
  await expect(panel.getByText('Type to search your channels and conversations.')).toHaveCount(0);
  expect(asked).toBe(0);
  // Once typing has stopped for the wait, the search runs.
  await page.clock.runFor(400);
  await expect.poll(() => asked).toBe(1);
});
