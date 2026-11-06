// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  showActions,
} from './helpers';

const ROOT = mockMessage(1, 'Release plan for Friday?');

async function openActions(page: import('@playwright/test').Page, text: string) {
  const msg = page.getByTestId('message').filter({ hasText: text }).first();
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  return page.getByRole('menu');
}

test('a reply goes to its thread; also sent, it shows in the channel', async ({
  page,
  isMobile,
}, testInfo) => {
  const api = await mockApi(page, { messages: [ROOT] });
  await page.goto(`/c/${GENERAL.id}`);
  await (
    await openActions(page, 'Release plan')
  )
    .getByRole('menuitem', { name: 'Reply in thread' })
    .click();

  const panel = page.getByTestId('thread-panel');
  await expect(panel.getByRole('heading', { name: 'Thread' })).toBeVisible();
  await expect(panel.getByTestId('message').filter({ hasText: 'Release plan' })).toBeVisible();
  const reply = panel.getByLabel('Reply…');
  await reply.fill('Friday works');
  await reply.press('Enter');
  await expect(panel.getByTestId('message').filter({ hasText: 'Friday works' })).toBeVisible();
  expect(api.sent.at(-1)).toMatchObject({
    body: 'Friday works',
    root_id: ROOT.id,
    also_in_channel: false,
  });
  // Not in the channel's timeline; the root shows the summary.
  const log = page.getByRole('log', { name: /Messages in/ });
  await expect(page.locator('main').getByText('Friday works')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Unfollow' })).toBeVisible();
  await expectTargetSizes(page, testInfo, '[data-testid="thread-panel"]');
  await expectNoAxeViolations(page, '[data-testid="thread-panel"]');

  // Also sent to the channel: it shows there, with a way to the thread.
  await reply.fill('Shipping notes follow');
  await panel.getByLabel(/Also send to/).check();
  await reply.press('Enter');
  await expect(panel.getByText('Shipping notes follow')).toBeVisible();
  // On phones the thread covers the channel.
  if (isMobile) await panel.getByRole('button', { name: 'Close thread' }).click();
  await expect(log.getByText('Shipping notes follow')).toBeVisible();
  await expect(log.getByRole('button', { name: 'Replied to a thread' })).toBeVisible();
  expect(api.sent.at(-1)).toMatchObject({ also_in_channel: true });

  // The thread shows under Threads.
  await page.goto('/threads');
  await expect(page.getByTestId('followed-thread')).toContainText('Release plan');
});

test('a message is pinned and listed in the channel details', async ({ page, isMobile }) => {
  await mockApi(page, { messages: [ROOT] });
  await page.goto(`/c/${GENERAL.id}`);
  await (
    await openActions(page, 'Release plan')
  )
    .getByRole('menuitem', { name: 'Pin to channel' })
    .click();
  await expect(page.getByTestId('pinned').first()).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Channel details' }).click();
  await expect(page.getByTestId('pins')).toContainText('Release plan');
});

test('saved for later, with a reminder, then done', async ({ page }) => {
  await mockApi(page, { messages: [ROOT] });
  await page.goto(`/c/${GENERAL.id}`);
  await (
    await openActions(page, 'Release plan')
  )
    .getByRole('menuitem', { name: 'Save for later' })
    .click();
  await expect(page.getByText('Saved for later')).toBeVisible();

  await page.goto('/saved');
  const item = page.getByTestId('saved-item');
  await expect(item).toContainText('Release plan');
  await item.getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: 'In 1 hour' }).click();
  // The reminder's time stands in the first column of the board.
  await expect(item.locator('time')).toBeVisible();
  await expectNoAxeViolations(page, 'main');
  await item.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByText('Nothing saved.', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: 'Done' }).click();
  await expect(page.getByTestId('saved-item')).toContainText('Release plan');
});
