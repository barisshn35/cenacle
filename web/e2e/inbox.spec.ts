// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { GENERAL, expectNoAxeViolations, expectTargetSizes, mockApi, mockMessage } from './helpers';

const channel = {
  id: GENERAL.id,
  name: 'General',
  kind: 'standard',
  workspace_id: GENERAL.workspace_id,
};

function item(kind: 'mention' | 'reply' | 'reaction', n: number, name: string, body: string) {
  const message = mockMessage(n, body);
  return {
    kind,
    at: new Date(Date.now() - n * 60_000).toISOString(),
    actor: { id: `01a15e50-bbbb-7000-8000-${String(n).padStart(12, '0')}`, display_name: name },
    emoji: kind === 'reaction' ? '👍' : '',
    message,
    channel,
  };
}

test('the Inbox is a board whose new rows stay lit until seen', async ({ page }, testInfo) => {
  const messages = [mockMessage(1, 'Can you review the release notes?')];
  await mockApi(page, { messages });
  const items = [
    item('mention', 1, 'Mert Kaya', 'Can you review the release notes?'),
    item('reply', 2, 'Ayşe Yılmaz', 'Done, the checklist is updated.'),
    item('reaction', 3, 'Zeynep Ak', 'Staging deploy is green.'),
  ];
  await page.route(/\/api\/me\/activity/, (route) =>
    route.fulfill({ json: { items, has_more: false } }),
  );
  await page.goto('/activity');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inbox');

  const rows = page.getByTestId('inbox-row');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[data-testid="inbox-row"][data-lit]')).toHaveCount(3);
  await expect(page.getByText('3 new')).toBeVisible();
  await expect(rows.first()).toContainText('Mert Kaya');
  await expect(rows.first()).toContainText('Mentioned you');

  await expectNoAxeViolations(page);
  await expectTargetSizes(page, testInfo);

  // Marking one as seen turns it off, and it stays so.
  if (!testInfo.project.name.includes('coarse')) {
    await page.getByRole('button', { name: 'Mark seen, from Zeynep Ak' }).click();
    await expect(page.locator('[data-testid="inbox-row"][data-lit]')).toHaveCount(2);
    await page.reload();
    await expect(page.locator('[data-testid="inbox-row"][data-lit]')).toHaveCount(2);
    // Opening a row goes to the message and marks it seen.
    await page.getByRole('button', { name: 'Open, from Mert Kaya' }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${GENERAL.id}`));
  }

  await page.goto('/activity');
  await page.getByRole('button', { name: 'Mark all seen' }).click();
  await expect(page.locator('[data-testid="inbox-row"][data-lit]')).toHaveCount(0);
  await expect(page.getByText('0 new')).toBeVisible();
});
