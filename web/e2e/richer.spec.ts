// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  directWith,
  EMOJI,
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  PEOPLE,
  RANDOM,
  SESSION,
  STICKERS,
  showActions,
} from './helpers';

const MERT = PEOPLE.find((p) => p.display_name === 'Mert Kaya')!;

test('a link preview shows under its message; its author removes it', async ({ page }) => {
  const own = {
    ...mockMessage(1, 'Release notes: https://example.org/notes'),
    author: { id: SESSION.user.id, display_name: SESSION.user.display_name },
  };
  const api = await mockApi(page, { messages: [own, mockMessage(2, 'Thanks')] });
  let removed = false;
  await page.route('**/link-preview', (route) => {
    removed = route.request().method() === 'DELETE';
    return route.fulfill({ status: 204 });
  });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('Thanks')).toBeVisible();
  // The preview arrives after the message, over the live connection.
  api.emit('message.preview', {
    channel_id: GENERAL.id,
    message_id: own.id,
    link_preview: {
      url: 'https://example.org/notes',
      title: 'Release notes',
      description: 'What changed in this release',
      site_name: 'Example',
      image_url: '/api/pictures/01a15e50-e000-7000-8000-0000000000aa',
    },
  });
  const card = page.getByTestId('link-preview');
  await expect(card).toContainText('Release notes');
  await expect(card).toContainText('What changed in this release');
  await expectNoAxeViolations(page, '[data-testid="link-preview"]');
  await card.getByRole('button', { name: 'Remove preview' }).click();
  await expect.poll(() => removed).toBe(true);
  api.emit('message.preview', { channel_id: GENERAL.id, message_id: own.id, link_preview: null });
  await expect(card).toHaveCount(0);
});

test('a message is forwarded with a comment; the copy shows where it came from', async ({
  page,
}, testInfo) => {
  const forwarded = {
    ...mockMessage(2, 'look'),
    forward: {
      message_id: mockMessage(9, '').id,
      channel_id: RANDOM.id,
      channel_name: 'Random',
      author: { id: MERT.id, display_name: 'Mert Kaya' },
      body: 'The **original** text',
      created_at: '2026-10-21T08:00:00Z',
    },
  };
  const dm = directWith(MERT);
  await mockApi(page, { channels: [dm], messages: [mockMessage(1, 'Worth sharing'), forwarded] });
  let body: unknown;
  await page.route('**/forward', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: { ...mockMessage(50, 'fyi'), channel_id: RANDOM.id },
    });
  });
  await page.goto(`/c/${GENERAL.id}`);
  const quote = page.getByTestId('forwarded');
  await expect(quote).toContainText('Forwarded from Mert Kaya in Random');
  await expect(quote.locator('strong')).toHaveText('original');

  const msg = page.getByTestId('message').filter({ hasText: 'Worth sharing' });
  await msg.hover();
  await showActions(msg);
  await msg.getByRole('button', { name: 'Message actions' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Forward' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forward message' });
  await dialog.getByRole('option', { name: 'Mert Kaya' }).click();
  await dialog.getByLabel('Add a comment (optional)').fill('fyi');
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Forward' }).click();
  await expect(page.getByText('Message forwarded.')).toBeVisible();
  expect(body).toEqual({ channel_id: dm.id, comment: 'fyi' });
});

test('custom emoji show in text and reactions; stickers are sent from the composer', async ({
  page,
}) => {
  const api = await mockApi(page, {
    messages: [mockMessage(1, 'Shipped :party: today')],
    emoji: EMOJI,
    stickers: STICKERS,
  });
  await page.route(/\/reactions\//, (route) => route.fulfill({ status: 204 }));
  await page.goto(`/c/${GENERAL.id}`);
  const msg = page.getByTestId('message').filter({ hasText: 'Shipped' });
  await expect(msg.getByRole('img', { name: ':party:' })).toBeVisible();

  await msg.hover();
  await showActions(msg);
  await msg.getByRole('button', { name: 'Add reaction' }).click({ force: true });
  await page.getByTestId('custom-emoji').getByRole('button', { name: ':party:' }).click();
  await expect(msg.getByRole('button', { name: /:party:/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Stickers' }).click();
  await page.getByTestId('sticker-list').getByRole('button', { name: 'Wave' }).click();
  await expect.poll(() => api.sent.at(-1)).toMatchObject({ body: '', sticker_id: STICKERS[0]!.id });
  await expect(page.getByTestId('sticker').last()).toHaveAttribute('alt', 'Wave');
});

test('burn-on-read: sent with a time in conversations, revealed by its reader', async ({
  page,
}) => {
  const dm = directWith(MERT);
  const hidden = {
    ...mockMessage(1, ''),
    channel_id: dm.id,
    author: { id: MERT.id, display_name: 'Mert Kaya' },
    burn: { seconds: 30, revealed_at: null, hidden: true },
  };
  const api = await mockApi(page, { channels: [dm], messages: [hidden] });
  await page.route('**/reveal', (route) =>
    route.fulfill({
      json: {
        ...hidden,
        body: 'The code is 1234',
        burn: { seconds: 30, revealed_at: new Date().toISOString(), hidden: false },
      },
    }),
  );
  await page.goto(`/c/${dm.id}`);
  const burn = page.getByTestId('burn');
  await expect(burn).not.toContainText('1234');
  await burn.getByRole('button', { name: 'Show message' }).click();
  await expect(burn).toContainText('The code is 1234');
  await expect(page.getByTestId('burn-note')).toContainText(/Burns in/);

  await page.getByTestId('burn-choice').selectOption('30');
  await page.getByRole('textbox', { name: /Message/ }).fill('secret');
  await page.keyboard.press('Enter');
  await expect.poll(() => api.sent.at(-1)).toMatchObject({ body: 'secret', burn_seconds: 30 });
});

test('@channel in a larger channel asks first', async ({ page }) => {
  const api = await mockApi(page, { messages: [] });
  await page.route('**/api/channels/*/members', (route) =>
    route.fulfill({
      json: {
        members: Array.from({ length: 8 }, (_, i) => ({
          user: { id: `01a15e50-bbbb-7000-8000-00000000000${i}`, display_name: `P${i}` },
          role: 'member',
        })),
      },
    }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('textbox', { name: /Message/ }).fill('@channel standup now');
  // While typing, the composer says whom it reaches.
  await expect(page.getByTestId('broadcast-reach')).toHaveText('Notifies 7 people in this channel');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Notify everyone?' });
  await expect(dialog).toContainText('This notifies 7 people in this channel.');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Send and notify' }).click();
  await expect.poll(() => api.sent.at(-1)?.body).toBe('@channel standup now');
});

test('a voice message plays from its own player', async ({ page }) => {
  const voice = {
    ...mockMessage(1, ''),
    files: [
      {
        id: '01a15e50-f000-7000-8000-000000000001',
        name: 'voice.webm',
        content_type: 'audio/webm',
        size: 2048,
        has_thumbnail: false,
        media_kind: 'voice',
        duration_ms: 4200,
        waveform: [0, 40, 255, 120, 60],
      },
    ],
  };
  await mockApi(page, { messages: [voice] });
  await page.goto(`/c/${GENERAL.id}`);
  const player = page.getByTestId('voice');
  await expect(player).toContainText('0:04');
  await expect(player.getByRole('button', { name: 'Play voice message' })).toBeVisible();
  await expectNoAxeViolations(page, '[data-testid="voice"]');
});

test('emotes: typed with ":", picked from the emoji button, shown large on their own', async ({
  page,
}) => {
  const api = await mockApi(page, {
    messages: [mockMessage(1, ':party: :party:'), mockMessage(2, 'Shipped :party: today')],
    emoji: EMOJI,
  });
  await page.goto(`/c/${GENERAL.id}`);
  const composer = page.getByLabel('Message General');

  // An emote alone is large; one within text stays the size of the text.
  await expect(page.getByTestId('message').first().locator('[data-jumbo]')).toHaveCount(1);
  await expect(
    page.getByTestId('message').filter({ hasText: 'Shipped' }).locator('[data-jumbo]'),
  ).toHaveCount(0);

  // ":pa" suggests the workspace's emoji; Enter puts it in.
  await composer.fill('Nice :pa');
  await composer.press('End');
  const list = page.getByTestId('emoji-suggest');
  await expect(list.getByRole('option', { name: ':party:' })).toBeVisible();
  await composer.press('Enter');
  await expect(composer).toHaveValue('Nice :party: ');
  // Times are not taken for emoji.
  await composer.fill('at 10:30');
  await expect(list).toHaveCount(0);

  // The emoji button puts the workspace's emoji where the caret is.
  await composer.fill('');
  await page.getByRole('button', { name: 'Add emoji' }).click();
  await page.getByTestId('custom-emoji').getByRole('button', { name: ':party:' }).click();
  await expect(composer).toHaveValue(':party: ');
  await expect(composer).toBeFocused();
  await composer.press('Enter');
  await expect.poll(() => api.sent.at(-1)).toMatchObject({ body: ':party:' });
});

test('the sticker picker shows packs as sections', async ({ page }) => {
  const pack = {
    id: '01a15e50-5a00-7000-8000-000000000001',
    name: 'Cats',
    created_by: null,
    created_at: '2026-11-08T10:00:00Z',
  };
  await mockApi(page, {
    stickers: [
      ...STICKERS,
      {
        id: '01a15e50-5000-7000-8000-000000000002',
        name: 'Purr',
        url: '/api/pictures/01a15e50-5000-7000-8000-0000000000e2',
        created_by: null,
        pack_id: pack.id,
      },
    ],
    stickerPacks: [pack],
  });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Stickers' }).click();
  const list = page.getByTestId('sticker-list');
  await expect(list.getByRole('region', { name: 'Cats' }).getByRole('button')).toHaveAccessibleName(
    'Purr',
  );
  await expect(
    list.getByRole('region', { name: 'Other' }).getByRole('button'),
  ).toHaveAccessibleName('Wave');
});

test('a .zip of GIFs becomes a sticker pack, named after the archive', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'workspace settings open from the sidebar on wide screens');
  const { zipSync } = await import('fflate');
  await mockApi(page, { admin: true });
  const made: string[] = [];
  const added: string[] = [];
  await page.route(/\/sticker-packs$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    made.push((route.request().postDataJSON() as { name: string }).name);
    return route.fulfill({
      status: 201,
      json: {
        id: '01a15e50-5a00-7000-8000-000000000009',
        name: 'Party Cats',
        created_by: SESSION.user.id,
        created_at: '2026-11-08T10:00:00Z',
      },
    });
  });
  await page.route(/\/stickers\?/, (route) => {
    added.push(new URL(route.request().url()).search);
    return route.fulfill({
      status: 201,
      json: {
        id: crypto.randomUUID(),
        name: 'x',
        url: '/x',
        created_by: SESSION.user.id,
        pack_id: null,
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Workspace menu: Cenacle' }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  const section = page
    .getByRole('dialog', { name: 'Workspace settings' })
    .getByTestId('manage-stickers');
  const zip = zipSync({
    'cats/2-nap.gif': new Uint8Array(8),
    'cats/1-purr.gif': new Uint8Array(8),
    'cats/read me.txt': new Uint8Array(8),
  });
  await section
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'party-cats.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zip),
    });
  await expect(page.getByText('2 stickers added.')).toBeVisible();
  expect(made).toEqual(['party cats']);
  expect(added).toEqual([
    '?name=1%20purr&pack_id=01a15e50-5a00-7000-8000-000000000009',
    '?name=2%20nap&pack_id=01a15e50-5a00-7000-8000-000000000009',
  ]);
});
