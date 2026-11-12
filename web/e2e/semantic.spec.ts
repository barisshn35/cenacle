// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { DEFAULT_WS, GENERAL, mockApi, expectNoAxeViolations } from './helpers';

const hit = {
  id: '01a16700-0000-7000-8000-000000000001',
  channel: { id: GENERAL.id, workspace_id: DEFAULT_WS, name: 'General', kind: 'public' },
  author: { id: '01a15dab-33d6-722d-aa40-6f2370b89146', display_name: 'Ayşe Yılmaz' },
  body: 'We ship on the 4th, finally.',
  created_at: '2026-11-10T10:00:00Z',
  has_files: false,
};

test('searching by meaning asks the AI notice first, then finds what was meant', async ({
  page,
}) => {
  await mockApi(page, { ai: true, semanticSearch: true });
  const asked: string[] = [];
  await page.route('**/api/search/messages?**', (route) => {
    const url = new URL(route.request().url());
    asked.push(url.search);
    const meaning = url.searchParams.get('mode') === 'meaning';
    return route.fulfill({ json: { results: meaning ? [hit] : [], has_more: false } });
  });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Search messages and files' }).click();
  const panel = page.getByTestId('search-panel');
  await panel.getByRole('searchbox', { name: 'Search for' }).fill('release date');
  await expect(panel.getByText('No messages found', { exact: false })).toBeVisible();

  // The notice comes before the first search by meaning (the query goes to the model).
  await panel.getByLabel('Search by meaning').click();
  const notice = page.getByRole('dialog', { name: 'Before you use AI' });
  await notice.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(panel.getByLabel('Search by meaning')).toBeChecked();
  await expect(panel).toContainText('We ship on the 4th, finally.');
  const last = new URLSearchParams(asked.at(-1)!);
  expect(last.get('mode')).toBe('meaning');
  expect(last.get('workspace_id')).toBe(DEFAULT_WS);
  await expectNoAxeViolations(page);
});

test('without the index the option is not offered', async ({ page }) => {
  await mockApi(page, { ai: true, aiConsent: 'accepted' });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Search messages and files' }).click();
  await expect(page.getByTestId('search-panel').getByLabel('Search by meaning')).toHaveCount(0);
});
