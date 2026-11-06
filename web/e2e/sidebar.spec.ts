// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import {
  directWith,
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  PEOPLE,
  showActions,
} from './helpers';

const MERT = PEOPLE[2]!;

/** Opens the menu of a channel in the sidebar. */
async function channelMenu(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Channels' });
  const item = nav.locator('li', { has: page.getByRole('link', { name: new RegExp(name) }) });
  await item.hover();
  await nav.getByRole('button', { name: `${name} options` }).click();
  return page.getByRole('menu');
}

test.describe('personal sidebar', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, 'the sidebar is in the drawer on phones');
  });

  test('Favorites and own sections, kept for the person', async ({ page }) => {
    const dm = directWith(MERT);
    const api = await mockApi(page, { channels: [dm] });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Channels' });

    // A channel goes to Favorites from its menu.
    await (
      await channelMenu(page, 'General')
    )
      .getByRole('menuitem', { name: 'Add to Favorites' })
      .click();
    const favorites = nav.locator('[data-section="favorites"]');
    await expect(favorites.getByRole('button', { name: 'Favorites', exact: true })).toBeVisible();
    await expect(favorites.getByRole('link', { name: /General/ })).toBeVisible();
    await expect
      .poll(() => (api.sidebar.placements as Record<string, string>)[GENERAL.id])
      .toBe('favorites');

    // A conversation goes to a new section of one's own.
    const menu = await channelMenu(page, 'Mert Kaya');
    await menu.getByRole('menuitem', { name: 'Move to' }).click();
    await page.getByRole('menuitem', { name: 'New section…' }).click();
    const dialog = page.getByRole('dialog', { name: 'New section…' });
    await dialog.getByLabel('Name').fill('Ekip');
    await dialog.getByRole('button', { name: 'Create' }).click();
    const own = nav.locator('[data-section]', {
      has: page.getByRole('button', { name: 'Ekip', exact: true }),
    });
    await expect(own.getByRole('link', { name: /Mert Kaya/ })).toBeVisible();
    await expect(
      nav.locator('[data-section="direct"]').getByText('No conversations yet.'),
    ).toBeVisible();

    // Sections fold away, and the choice is kept.
    await own.getByRole('button', { name: 'Ekip', exact: true }).click();
    await expect(own.getByRole('link', { name: /Mert Kaya/ })).toBeHidden();
    await expect.poll(() => (api.sidebar.collapsed as string[]).length).toBe(1);
    await own.getByRole('button', { name: 'Ekip', exact: true }).click();

    // Deleting the section sends the conversation back; Undo restores it.
    await own.getByRole('button', { name: 'Ekip options' }).click();
    await page.getByRole('menuitem', { name: 'Delete section' }).click();
    await expect(
      nav.locator('[data-section="direct"]').getByRole('link', { name: /Mert Kaya/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(own.getByRole('link', { name: /Mert Kaya/ })).toBeVisible();

    // Moving a section up puts it above Favorites.
    await own.getByRole('button', { name: 'Ekip options' }).click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    await expect(nav.locator('[data-section]').first()).toHaveAttribute(
      'data-section',
      /^[0-9a-f-]{36}$/,
    );

    await expectTargetSizes(page, test.info(), 'nav');
    await expectNoAxeViolations(page, 'nav');
  });

  test('unread ones gather at the top when asked', async ({ page }) => {
    await mockApi(page, { general: { unread_count: 3 } });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Channels' });
    await nav.getByRole('button', { name: 'Channels options' }).click();
    await page
      .getByRole('menuitemcheckbox', { name: 'Show unread ones together at the top' })
      .click();
    const unreads = nav.locator('[data-section="unreads"]');
    await expect(unreads.getByRole('link', { name: /General/ })).toBeVisible();
    await expect(nav.locator('[data-section]').first()).toHaveAttribute('data-section', 'unreads');
  });

  test('a channel is marked read or unread from the sidebar', async ({ page }) => {
    const api = await mockApi(page, { general: { unread_count: 2 } });
    await page.goto('/');
    await (
      await channelMenu(page, 'General')
    )
      .getByRole('menuitem', { name: 'Mark as read' })
      .click();
    await expect.poll(() => api.reads.get(GENERAL.id)).toBe('newest');
    await expect(
      page.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: /unread/ }),
    ).toHaveCount(0);
  });
});

test('a message is marked unread and the channel stays unread while open', async ({ page }) => {
  const messages = [1, 2, 3].map((n) => mockMessage(n, `mesaj ${n}`));
  const api = await mockApi(page, { messages });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByTestId('message')).toHaveCount(3);
  await expect.poll(() => api.reads.get(GENERAL.id)).toBe(messages[2]!.id);

  const second = page.getByTestId('message').nth(1);
  await second.hover();
  await showActions(second);
  await second.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect.poll(() => api.unreads).toEqual([`${GENERAL.id}:${messages[1]!.id}`]);
  // The line moves above it, and reading does not start again here.
  const line = page.getByTestId('new-messages');
  await expect(line).toBeVisible();
  await expect(page.getByTestId('message').nth(1)).toContainText('mesaj 2');
  api.reads.clear();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(500);
  expect(api.reads.size).toBe(0);
});
