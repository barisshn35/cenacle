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

test('several messages are picked and forwarded together, oldest first', async ({
  page,
}, testInfo) => {
  const dm = directWith(MERT);
  await mockApi(page, {
    channels: [dm],
    messages: [
      mockMessage(1, 'First point'),
      mockMessage(2, 'Second point'),
      mockMessage(3, 'Third'),
    ],
  });
  const sent: { url: string; body: unknown }[] = [];
  await page.route('**/forward', (route) => {
    sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({
      status: 201,
      json: { ...mockMessage(60 + sent.length, 'x'), channel_id: dm.id },
    });
  });
  await page.goto(`/c/${GENERAL.id}`);
  const second = page.getByTestId('message').filter({ hasText: 'Second point' });
  await showActions(second);
  await second.getByRole('button', { name: 'Message actions' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Select messages' }).click();

  // The composer gives way to the picking bar; the chosen message is picked.
  const bar = page.getByTestId('pick-bar');
  await expect(bar).toContainText('1 message selected');
  await expect(page.getByRole('textbox', { name: /^Message/ })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select message from Ayşe Yılmaz' }).first().check();
  await expect(bar).toContainText('2 messages selected');
  await expectTargetSizes(page, testInfo, '[data-testid="pick-bar"]');
  await expectNoAxeViolations(page, '[role="log"]');

  await bar.getByRole('button', { name: 'Forward' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forward 2 messages' });
  await dialog.getByRole('option', { name: 'Mert Kaya' }).click();
  await dialog.getByLabel('Add a comment (optional)').fill('both');
  await dialog.getByRole('button', { name: 'Forward' }).click();
  await expect(page.getByText('2 messages forwarded.')).toBeVisible();
  // In the order they were written; the comment rides with the first.
  expect(sent.map((s) => s.url.match(/messages\/([^/]+)\/forward/)![1])).toEqual([
    mockMessage(1, '').id,
    mockMessage(2, '').id,
  ]);
  expect(sent.map((s) => s.body)).toEqual([
    { channel_id: dm.id, comment: 'both' },
    { channel_id: dm.id },
  ]);
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
});

test('picking stops with Escape and keeps to ten messages', async ({ page }) => {
  await mockApi(page, {
    messages: Array.from({ length: 12 }, (_, i) => mockMessage(i + 1, `Note ${i + 1}`)),
  });
  await page.goto(`/c/${GENERAL.id}`);
  const first = page.getByTestId('message').filter({ hasText: 'Note 12' });
  await showActions(first);
  await first.getByRole('button', { name: 'Message actions' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Select messages' }).click();
  const unpicked = page.getByRole('checkbox', { name: /^Select message from/, checked: false });
  for (let n = 1; n < 10; n++) await unpicked.last().check();
  await expect(page.getByTestId('pick-bar')).toContainText('10 messages selected');
  // An eleventh is not taken (higher up on small screens).
  await page.getByTestId('virtuoso-scroller').evaluate((el) => (el.scrollTop = 0));
  await unpicked.first().click();
  await expect(page.getByText('You can forward up to 10 messages at once.')).toBeVisible();
  await expect(page.getByTestId('pick-bar')).toContainText('10 messages selected');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pick-bar')).toHaveCount(0);
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
  await page.getByTestId('sticker-list').getByRole('button', { name: 'Wave', exact: true }).click();
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
  await expect(
    list.getByRole('region', { name: 'Cats' }).getByRole('button').first(),
  ).toHaveAccessibleName('Purr');
  await expect(
    list.getByRole('region', { name: 'Other' }).getByRole('button').first(),
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

test('a member makes a sticker from a picture and sends it', async ({ page }, testInfo) => {
  const api = await mockApi(page);
  // A 2×1 red and blue PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=',
    'base64',
  );
  const uploads: { search: string; png: boolean; size: number }[] = [];
  const made = {
    id: '01a15e50-5a00-7000-8000-00000000000a',
    name: 'Ship it',
    url: '/api/pictures/made.png',
    created_by: SESSION.user.id,
    pack_id: null,
  };
  await page.route(/\/stickers\?/, (route) => {
    const r = route.request();
    uploads.push({
      search: new URL(r.url()).search,
      png: r.postDataBuffer()?.subarray(1, 4).toString() === 'PNG',
      size: r.postDataBuffer()?.length ?? 0,
    });
    return route.fulfill({ status: 201, json: made });
  });
  await page.goto(`/c/${GENERAL.id}`);

  // With no stickers yet, the button is there to make one.
  await page.getByRole('button', { name: 'Stickers' }).click();
  await expect(page.getByText('No stickers yet.')).toBeVisible();
  await page.getByTestId('sticker-make').click();
  const maker = page.getByRole('dialog', { name: 'Make a sticker' });
  await expect(maker.getByRole('button', { name: 'Save and send' })).toBeDisabled();
  await maker.getByTestId('sticker-maker-file').setInputFiles({
    name: 'ship_it.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(maker.getByLabel('Sticker name')).toHaveValue('ship it');
  await maker.getByLabel('Sticker name').fill('Ship it');
  await maker.getByLabel('Text at the bottom').fill('SHIP IT');
  // Moving without dragging: the arrow keys on the preview.
  await maker.getByRole('img', { name: 'Sticker preview' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(maker.getByRole('button', { name: 'Fit again' })).toBeEnabled();
  await expectTargetSizes(page, testInfo, '[data-testid="sticker-maker"]');
  await expectNoAxeViolations(page, '[data-testid="sticker-maker"]');

  await maker.getByRole('button', { name: 'Save and send' }).click();
  await expect(maker).toBeHidden();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.search).toBe('?name=Ship%20it');
  expect(uploads[0]!.png).toBe(true);
  // The drawn square, not the 2×1 original.
  expect(uploads[0]!.size).toBeGreaterThan(png.length);
  await expect.poll(() => api.sent.at(-1)).toMatchObject({ body: '', sticker_id: made.id });
});

test('a guest has no sticker maker', async ({ page }) => {
  await mockApi(page, { stickers: STICKERS, workspaceRole: 'guest' });
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Stickers' }).click();
  await expect(page.getByTestId('sticker-list')).toBeVisible();
  await expect(page.getByTestId('sticker-make')).toHaveCount(0);
});

// A 1×1 GIF.
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

/** One's GIFs on a mocked server: listed, added and removed. */
async function mockGifs(page: import('@playwright/test').Page) {
  const gifs: {
    id: string;
    name: string;
    width: number;
    height: number;
    size: number;
    url: string;
    created_at: string;
  }[] = [];
  const added: { name: string; size: number }[] = [];
  await page.route('**/api/me/gifs', (route) =>
    route.fulfill({ json: { gifs: [...gifs].reverse() } }),
  );
  await page.route('**/api/me/gifs?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name')!;
    const size = route.request().postDataBuffer()?.length ?? 0;
    added.push({ name, size });
    const id = `01a15e50-6100-7000-8000-${String(gifs.length + 1).padStart(12, '0')}`;
    const gif = {
      id,
      name,
      width: 2,
      height: 2,
      size,
      url: `/api/gifs/${id}`,
      created_at: '2026-11-09T10:00:00Z',
    };
    gifs.push(gif);
    return route.fulfill({ status: 201, json: gif });
  });
  await page.route(/\/api\/gifs\/[0-9a-f-]{36}$/, (route) =>
    route.fulfill({ body: GIF, contentType: 'image/gif' }),
  );
  return { gifs, added };
}

test('a sticker someone made is saved; saved ones come first', async ({ page }) => {
  const purr = {
    id: '01a15e50-5000-7000-8000-000000000002',
    name: 'Purr',
    url: '/api/pictures/01a15e50-5000-7000-8000-0000000000e2',
    created_by: MERT.id,
    pack_id: null,
  };
  await mockApi(page, {
    stickers: [...STICKERS, purr],
    messages: [
      { ...mockMessage(3, '', 'Mert Kaya'), sticker: purr } as ReturnType<typeof mockMessage>,
    ],
  });
  const saves: string[] = [];
  await page.route(/\/api\/stickers\/[0-9a-f-]{36}\/save$/, (route) => {
    saves.push(`${route.request().method()} ${route.request().url().split('/').at(-2)}`);
    return route.fulfill({ status: 204 });
  });
  await page.goto(`/c/${GENERAL.id}`);

  // From the message that shows it.
  const message = page.getByTestId('message').filter({ has: page.getByTestId('sticker') });
  await message.hover();
  await showActions(message);
  await message.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Save sticker' }).click();
  await expect.poll(() => saves).toEqual([`PUT ${purr.id}`]);

  // In the picker it comes first, and can be taken out there.
  await page.getByRole('button', { name: 'Stickers' }).click();
  const list = page.getByTestId('sticker-list');
  await expect(list.getByRole('region').first()).toHaveAccessibleName('Saved');
  await expect(
    list.getByRole('region', { name: 'Saved' }).getByRole('button', { name: 'Purr', exact: true }),
  ).toBeVisible();
  await list
    .getByRole('region', { name: 'Saved' })
    .getByRole('button', { name: 'Take Purr out of saved' })
    .click();
  await expect(list.getByRole('region', { name: 'Saved' })).toHaveCount(0);
  expect(saves.at(-1)).toBe(`DELETE ${purr.id}`);
  // Saving from the picker: the star of a sticker.
  await list.getByRole('button', { name: 'Save Wave' }).click();
  await expect(
    list.getByRole('region', { name: 'Saved' }).getByRole('button', { name: 'Wave', exact: true }),
  ).toBeVisible();
});

test("a GIF in someone's message is kept, then sent again from the GIF tab", async ({
  page,
}, testInfo) => {
  const file = {
    id: '01a15e50-f11e-7000-8000-000000000009',
    name: 'dance.gif',
    content_type: 'image/gif',
    size: GIF.length,
    width: 2,
    height: 2,
    has_thumbnail: false,
  };
  await mockApi(page, { messages: [{ ...mockMessage(3, 'look', 'Mert Kaya'), files: [file] }] });
  const { added } = await mockGifs(page);
  await page.route(/\/api\/files\/[0-9a-f-]{36}\/(content|thumbnail)/, (route) =>
    route.fulfill({ body: GIF, contentType: 'image/gif' }),
  );
  const uploads: string[] = [];
  await page.route(`**/api/channels/${GENERAL.id}/files`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const { name } = route.request().postDataJSON() as { name: string };
    uploads.push(name);
    return route.fulfill({
      status: 201,
      json: {
        file: { ...file, id: '01a15e50-f11e-7000-8000-000000000010', name },
        upload: { url: '/cenacle-files/', fields: {} },
      },
    });
  });
  await page.route('**/cenacle-files/', (route) => route.fulfill({ status: 204 }));
  await page.route(/\/api\/files\/[0-9a-f-]{36}\/complete$/, (route) =>
    route.fulfill({ json: { ...file, id: '01a15e50-f11e-7000-8000-000000000010' } }),
  );
  await page.goto(`/c/${GENERAL.id}`);

  const message = page.getByTestId('message').filter({ hasText: 'look' });
  await message.hover();
  await showActions(message);
  await message.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Keep GIF' }).click();
  await expect(page.getByText('GIF kept in your GIFs.')).toBeVisible();
  expect(added).toEqual([{ name: 'dance', size: GIF.length }]);

  await page.getByRole('button', { name: 'Stickers' }).click();
  await page.getByRole('tab', { name: 'GIFs' }).click();
  await expect(page.getByText('1 of 40 GIFs')).toBeVisible();
  await expectTargetSizes(page, testInfo, '#sticker-panel-gifs');
  await expectNoAxeViolations(page, '#sticker-panel-gifs');
  await page.getByTestId('gif-list').getByRole('button', { name: 'dance', exact: true }).click();
  // It goes into the message being written, as an upload.
  await expect(page.getByTestId('upload')).toContainText('dance.gif');
  expect(uploads).toEqual(['dance.gif']);
});

test('a GIF is made from a part of a video and kept', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'records the test video with MediaRecorder');
  await mockApi(page);
  const { added } = await mockGifs(page);
  await page.goto(`/c/${GENERAL.id}`);
  // A short video, recorded in the page from a canvas.
  const webm = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
    const ctx = canvas.getContext('2d')!;
    const recorder = new MediaRecorder(canvas.captureStream(20), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (recorder.onstop = r));
    recorder.start();
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = `hsl(${i * 15} 80% 50%)`;
      ctx.fillRect(0, 0, 64, 48);
      await new Promise((r) => setTimeout(r, 50));
    }
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });

  await page.getByRole('button', { name: 'Stickers' }).click();
  await page.getByRole('tab', { name: 'GIFs' }).click();
  await expect(page.getByText('No GIFs yet.', { exact: false })).toBeVisible();
  await page.getByTestId('gif-make').click();
  const maker = page.getByRole('dialog', { name: 'Make a GIF from a video' });
  await maker.getByTestId('gif-maker-file').setInputFiles({
    name: 'party_time.webm',
    mimeType: 'video/webm',
    buffer: Buffer.from(webm, 'base64'),
  });
  await expect(maker.getByLabel('Preview of the chosen part')).toBeVisible();
  await maker.getByLabel('Text at the bottom').fill('YES');
  await maker.getByLabel('Frames per second').selectOption('10');
  await maker.getByRole('button', { name: 'Make GIF' }).click();
  await expect(maker.getByTestId('gif-maker-result')).toBeVisible({ timeout: 20_000 });
  await expect(maker.getByLabel('GIF name')).toHaveValue('party time');
  await maker.getByRole('button', { name: 'Keep in my GIFs' }).click();
  await expect(maker).toBeHidden();
  expect(added).toHaveLength(1);
  expect(added[0]!.name).toBe('party time');
  expect(added[0]!.size).toBeGreaterThan(100);
});
