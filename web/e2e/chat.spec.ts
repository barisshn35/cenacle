// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  CENTRAL,
  GENERAL,
  RANDOM,
  expectNoAxeViolations,
  expectTargetSizes,
  mockApi,
  mockMessage,
  showActions,
} from './helpers';

const composer = (page: import('@playwright/test').Page) => page.getByLabel('Message General');

test('the home page opens General with its history', async ({ page, isMobile }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await mockApi(page, {
    messages: [
      mockMessage(1, 'Günaydın!'),
      mockMessage(2, 'Deploy tamam.'),
      mockMessage(30, 'Öğlen?', 'Mert Kaya'),
    ],
  });
  await page.goto('/');
  await expect(page).toHaveURL(`/c/${GENERAL.id}`);
  const log = page.getByRole('log', { name: 'Messages in General' });
  await expect(log.getByTestId('message')).toHaveCount(3);
  await expect(log.getByText('Deploy tamam.')).toBeVisible();
  // Consecutive messages of one author share one visible header (screen
  // readers still get the author of every message).
  const headers = log.locator('header:not(.sr-only)');
  await expect(headers.filter({ hasText: 'Ayşe Yılmaz' })).toHaveCount(1);
  await expect(headers.filter({ hasText: 'Mert Kaya' })).toHaveCount(1);
  await expect(log.getByRole('article', { name: 'Ayşe Yılmaz' })).toHaveCount(2);
  if (!isMobile) {
    // On phones the channel list is in the drawer.
    await expect(page.getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
  // React reports problems such as duplicate keys as console errors.
  expect(errors).toEqual([]);
});

test('sending shows the message at once and confirms it', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await composer(page).fill('İlk mesaj\nikinci satır');
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByTestId('message').filter({ hasText: 'İlk mesaj' })).toBeVisible();
  await expect(page.getByTestId('pending-message')).toHaveCount(0);
  expect(api.sent).toEqual([{ body: 'İlk mesaj\nikinci satır', nonce: expect.any(String) }]);

  // Shift+Enter adds a line; empty input does not send.
  await composer(page).press('Shift+Enter');
  await composer(page).press('Enter');
  expect(api.sent).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('messages from others arrive live and are not duplicated', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('This is the start of General.')).toBeVisible();
  const incoming = mockMessage(5, 'Canlı geldi', 'Mert Kaya');
  api.emit('message.created', incoming);
  api.emit('message.created', incoming); // delivered twice: shown once
  await expect(page.getByTestId('message').filter({ hasText: 'Canlı geldi' })).toHaveCount(1);
});

test('a message that could not be sent can be retried with the same nonce', async ({ page }) => {
  const api = await mockApi(page, { failSend: 1 });
  await page.goto('/');
  await composer(page).fill('Tekrar denenecek');
  await composer(page).press('Enter');
  const pending = page.getByTestId('pending-message');
  await expect(pending.getByRole('alert')).toContainText('Not sent');
  await expect(pending).toContainText('Tekrar denenecek');
  await pending.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('message').filter({ hasText: 'Tekrar denenecek' })).toBeVisible();
  await expect(pending).toHaveCount(0);
  expect(api.sent).toHaveLength(1);
});

test('drafts survive a reload', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await composer(page).fill('yarım kalan düşünce');
  await page.waitForTimeout(600); // drafts are saved shortly after typing stops
  await page.reload();
  await expect(composer(page)).toHaveValue('yarım kalan düşünce');
});

test('chat view: target size and axe with messages and a failed send', async ({
  page,
}, testInfo) => {
  await mockApi(page, {
    messages: [mockMessage(1, 'Merhaba'), mockMessage(9, 'Selam', 'Mert Kaya')],
    failSend: 1,
  });
  await page.goto('/');
  await composer(page).fill('olmadı');
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectTargetSizes(page, testInfo);
  await expectNoAxeViolations(page);
});

test('Central is read-only, cannot be left, and shows no "#"', async ({ page, isMobile }) => {
  await mockApi(page);
  await page.goto(`/c/${CENTRAL.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Central');
  await expect(page.getByRole('img', { name: 'Announcement channel' }).first()).toBeVisible();
  await expect(page.getByTestId('read-only-notice')).toContainText('Only announcements');
  await expect(page.getByLabel('Message Central')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('#');
  // On phones the details panel is a sheet that opens on request.
  if (isMobile) await page.getByRole('button', { name: 'Channel details' }).click();
  await expect(page.getByText('Everyone is a member of this channel.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave channel' })).toHaveCount(0);
});

test.describe('channels', () => {
  test.skip(({ isMobile }) => isMobile, 'sidebar actions are in the drawer on phones');

  test('members browse, join and leave with undo', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create a channel' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Browse channels' }).click();
    await page.getByRole('button', { name: 'Join Random' }).click();
    await expect(page).toHaveURL(`/c/${RANDOM.id}`);
    await expect(page.getByRole('link', { name: 'Random' })).toBeVisible();

    await page.getByRole('button', { name: 'Leave channel' }).click();
    await expect(page.getByRole('link', { name: 'Random' })).toHaveCount(0);
    await expect(page).toHaveURL(`/c/${GENERAL.id}`);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page).toHaveURL(`/c/${RANDOM.id}`);
    await expect(page.getByRole('link', { name: 'Random' })).toBeVisible();
  });

  test('the directory searches and filters channels', async ({ page }, testInfo) => {
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Browse channels' }).click();
    const dialog = page.getByRole('dialog', { name: 'Channels' });
    const rows = dialog.getByTestId('directory-channel');
    const total = await rows.count();
    expect(total).toBeGreaterThan(1);
    await dialog.getByRole('radio', { name: /^Not joined/ }).click();
    await expect(rows.filter({ hasText: 'General' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Random' })).toHaveCount(1);
    await dialog.getByRole('radio', { name: /^All/ }).click();
    await dialog.getByLabel('Search channels').fill('rand');
    await expect(rows).toHaveCount(1);
    await expect(dialog.getByRole('status')).toContainText('1 channel matches “rand”');
    await expectNoAxeViolations(page);
    await expectTargetSizes(page, testInfo);
  });

  test('the administrator creates channels', async ({ page }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create a channel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a channel' });
    await dialog.getByLabel('Name').fill('general');
    await dialog.getByRole('button', { name: 'Create channel' }).click();
    await expect(dialog.getByRole('alert')).toContainText('A channel with this name exists.');
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');

    await dialog.getByLabel('Name').fill('Release notes');
    await dialog.getByLabel('Topic (optional)').fill('What shipped');
    await dialog.getByRole('button', { name: 'Create channel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Release notes');
    await expect(page.getByRole('link', { name: 'Release notes' })).toBeVisible();
  });
});

test.describe('private channels', () => {
  test.skip(({ isMobile }) => isMobile, 'sidebar actions are in the drawer on phones');

  test('the administrator creates a private channel and adds people', async ({
    page,
  }, testInfo) => {
    await mockApi(page, { admin: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create a channel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a channel' });
    await dialog.getByLabel('Name').fill('Yönetim');
    await dialog.getByLabel('Private').check();
    await expect(dialog.getByLabel('Add everyone')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Create channel' }).click();

    await expect(page.getByRole('img', { name: 'Private channel' }).first()).toBeVisible();
    const details = page.getByRole('complementary');
    await expect(details).toContainText('Only members see it');
    await expect(details.getByTestId('members')).toContainText('Manager');

    await details.getByRole('button', { name: 'Add people' }).click();
    const add = page.getByRole('dialog', { name: 'Add people to Yönetim' });
    await add.getByLabel('Find people by name or e-mail').fill('ayşe');
    await add.getByRole('button', { name: 'Add Ayşe Yılmaz' }).click();
    await expect(add.getByText('Member', { exact: true })).toBeVisible();
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
    await page.keyboard.press('Escape');

    await expect(details.getByTestId('members')).toContainText('Ayşe Yılmaz');
    await details.getByRole('button', { name: 'Remove Ayşe Yılmaz from the channel' }).click();
    await expect(details.getByTestId('members')).not.toContainText('Ayşe Yılmaz');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(details.getByTestId('members')).toContainText('Ayşe Yılmaz');
  });

  test('a channel managed by directory groups keeps its members', async ({ page }, testInfo) => {
    const managed = { ...GENERAL, id: '01a15e50-6666-7d7d-bbee-8e7809fd8ad2', name: 'Builds' };
    await mockApi(page, {
      admin: true,
      channels: [
        {
          ...managed,
          visibility: 'private',
          is_default: false,
          group_managed: true,
        },
      ],
    });
    await page.goto(`/c/${managed.id}`);
    const details = page.getByRole('complementary');
    await expect(details).toContainText('Members come from directory groups.');
    await expect(details.getByRole('button', { name: 'Leave channel' })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Add people' })).toHaveCount(0);

    await details.getByRole('button', { name: 'Channel settings' }).click();
    const groups = page.getByRole('dialog').getByTestId('channel-groups');
    await groups.getByLabel('Groups (separated by commas)').fill('engineering, design');
    await groups.getByRole('button', { name: 'Save groups' }).click();
    await expect(page.getByText('Directory groups saved.')).toBeVisible();
    await expectTargetSizes(page, testInfo, '[role="dialog"]');
    await expectNoAxeViolations(page, '[role="dialog"]');
  });

  test('members who do not manage the channel cannot add people or change it', async ({ page }) => {
    await mockApi(page);
    await page.goto(`/c/${GENERAL.id}`);
    const details = page.getByRole('complementary');
    await expect(details.getByTestId('members')).toContainText('Deniz Kaya');
    await expect(details.getByRole('button', { name: 'Add people' })).toHaveCount(0);
    await expect(details.getByLabel('Visibility')).toHaveCount(0);
    await expect(details).toContainText('Everyone can find and join it.');
  });
});

test('on a phone the author and time stand above the words, never over them', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'the one-column layout of phones');
  await mockApi(page, {
    messages: [mockMessage(1, 'Good morning everyone, the release is ready.')],
  });
  await page.goto(`/c/${GENERAL.id}`);
  const message = page.getByTestId('message').first();
  await expect(message).toContainText('Good morning');
  // One column: nothing (such as the touch toolbar) may open a second one.
  const columns = await message.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(columns.trim().split(/\s+/)).toHaveLength(1);
  const who = await message.locator('header').first().boundingBox();
  const words = await message.getByText('Good morning').boundingBox();
  expect(who!.y + who!.height).toBeLessThanOrEqual(words!.y + 1);
});

test('focus stays in the list when the focused message scrolls out of it', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'keyboard focus');
  const messages = Array.from({ length: 120 }, (_, i) => mockMessage(i + 1, `Message ${i + 1}`));
  await mockApi(page, { messages });
  await page.goto(`/c/${GENERAL.id}`);
  const log = page.getByRole('log', { name: /Messages in/ });
  await expect(log.getByText('Message 120')).toBeVisible({ timeout: 15_000 });
  await showActions(log.getByTestId('message').last());
  await log.getByRole('button', { name: 'Add reaction' }).last().focus();
  // To the top: the virtual list drops the focused message.
  await log.locator('[data-virtuoso-scroller]').evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(log.getByText('Message 120')).toHaveCount(0);
  // Not the page (where the next Tab would start over): the list, by name.
  await expect(log).toBeFocused();
});

test('on touch screens a message shows its actions once tapped', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch screens only');
  await mockApi(page, { messages: [mockMessage(1, 'Dokunulacak mesaj'), mockMessage(2, 'Öbürü')] });
  await page.goto('/');
  const first = page.getByTestId('message').filter({ hasText: 'Dokunulacak mesaj' });
  const second = page.getByTestId('message').filter({ hasText: 'Öbürü' });
  const actions = (m: typeof first) => m.getByRole('button', { name: 'Message actions' });
  await expect(actions(first)).toBeHidden();
  await first.getByText('Dokunulacak mesaj').tap();
  await expect(actions(first)).toBeVisible();
  // One message at a time; tapping it again closes its actions.
  await second.getByText('Öbürü').tap();
  await expect(actions(first)).toBeHidden();
  await expect(actions(second)).toBeVisible();
  await second.getByText('Öbürü').tap();
  await expect(actions(second)).toBeHidden();
});

test('the composer keeps attach, format and send in view, the rest under "+"', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const footer = page.locator('footer');
  for (const name of ['Attach files', 'Show formatting', 'Send message'])
    await expect(footer.getByRole('button', { name, exact: true })).toBeVisible();
  for (const name of ['Record a voice message', 'Create poll', 'Message priority', 'Send later'])
    await expect(footer.getByRole('button', { name })).toHaveCount(0);
  await footer.getByRole('button', { name: /^More: / }).click();
  const menu = page.getByRole('menu');
  for (const name of ['Voice message', 'Video clip', 'Poll', 'Priority', 'Send later'])
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  await expectNoAxeViolations(page);
});
