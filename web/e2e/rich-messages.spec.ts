// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import {
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  PEOPLE,
  SESSION,
} from './helpers';

const [ME, AYSE] = PEOPLE as [(typeof PEOPLE)[number], (typeof PEOPLE)[number]];

test('messages render Markdown safely, with code, mentions and cards', async ({
  page,
}, testInfo) => {
  const markdown = {
    ...mockMessage(1, ''),
    body: [
      '**Kalın** ve _italik_, `kod` ve [bağlantı](https://example.com).',
      '',
      '```go',
      'func main() {}',
      '```',
      '',
      '<script>alert(1)</script>',
      '',
      '![resim](https://tracker.example/pixel.png)',
      '',
      `<@${ME.id}> ve <@${AYSE.id}> bakar mısınız?`,
      '',
      `[@Patron](https://evil.example/#mention-${ME.id}) [@Patron](#mention-${ME.id})`,
    ].join('\n'),
    mentions: [
      { id: ME.id, display_name: ME.display_name },
      { id: AYSE.id, display_name: AYSE.display_name },
    ],
  };
  const card = {
    ...mockMessage(2, ''),
    attachments: [
      {
        title: 'CEN-42: Giriş sayfası',
        title_link: 'https://jira.example.com/browse/CEN-42',
        text: '**Öncelik** yüksek',
        color: 'warning',
        fields: [{ title: 'Durum', value: 'Açık', short: true }],
      },
    ],
    reactions: [{ emoji: '👍', count: 2, me: true }],
  };
  const external: string[] = [];
  page.on('request', (r) => {
    if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) external.push(r.url());
  });
  await mockApi(page, { messages: [markdown, card] });
  await page.goto(`/c/${GENERAL.id}`);

  const first = page.getByTestId('message').first();
  await expect(first.locator('strong')).toHaveText('Kalın');
  await expect(first.getByRole('link', { name: 'bağlantı' })).toHaveAttribute('target', '_blank');
  // No raw HTML, no remote images: the image is a link.
  await expect(first.locator('script')).toHaveCount(0);
  await expect(first.locator('img')).toHaveCount(0);
  await expect(first.getByRole('link', { name: 'resim' })).toBeVisible();
  // Code is highlighted once its language loads.
  await expect(first.locator('pre[data-language="go"] span span').first()).toBeVisible();
  // Mentions: the reader's own stands out, and so does the message.
  await expect(first.getByTestId('mention')).toHaveText([
    `@${ME.display_name}`,
    `@${AYSE.display_name}`,
  ]);
  await expect(first).toHaveAttribute('data-mentions-me', 'true');

  const second = page.getByTestId('message').nth(1);
  const attachment = second.getByTestId('attachment');
  await expect(attachment.getByRole('link', { name: 'CEN-42: Giriş sayfası' })).toBeVisible();
  await expect(attachment).toContainText('Durum');
  await expect(second.getByRole('button', { name: /👍: 2 people including you/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  expect(external).toEqual([]);
  await expectTargetSizes(page, testInfo, '[role="log"]');
  await expectNoAxeViolations(page, '[role="log"]');
});

test('typing @ suggests people and sends a mention', async ({ page }) => {
  const api = await mockApi(page);
  // Members of General for the suggestions.
  await page.route('**/api/channels/*/members', (route) =>
    route.fulfill({
      json: { members: PEOPLE.map((p) => ({ user: p, role: 'member' })) },
    }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.pressSequentially('Merhaba @ayş');
  const list = page.getByRole('listbox', { name: 'People to mention' });
  await expect(list.getByRole('option')).toHaveText([/Ayşe Yılmaz/]);
  await box.press('Enter');
  await expect(box).toHaveValue('Merhaba @Ayşe Yılmaz ');
  await box.pressSequentially('nasılsın?');
  await box.press('Enter');
  await expect.poll(() => api.sent.at(-1)?.body).toBe(`Merhaba <@${AYSE.id}> nasılsın?`);
  await expect(page.getByTestId('mention').last()).toHaveText('@Ayşe Yılmaz');
  // Escape closes the suggestions without sending.
  await box.pressSequentially('@me');
  await expect(list).toBeVisible();
  await box.press('Escape');
  await expect(list).toBeHidden();
  expect(SESSION.user.id).toBe(ME.id);
});

test('reactions: add from the picker, toggle, and see others live', async ({ page }) => {
  const api = await mockApi(page, { messages: [mockMessage(1, 'tepki verin')] });
  await page.goto(`/c/${GENERAL.id}`);
  const message = page.getByTestId('message').first();
  await message.hover();
  await message.getByRole('button', { name: 'Add reaction' }).click();
  const search = page
    .getByRole('searchbox', { name: 'Search emoji' })
    .or(page.getByPlaceholder('Search emoji'));
  await search.fill('rocket');
  await page.getByRole('gridcell', { name: 'Rocket', exact: true }).click();
  await expect(message.getByRole('button', { name: /🚀: 1 person, you/ })).toBeVisible();
  expect(api.reacted).toEqual([`+🚀 ${mockMessage(1, '').id}`]);

  // Someone else reacts the same.
  api.emit('reaction.added', {
    channel_id: GENERAL.id,
    message_id: mockMessage(1, '').id,
    emoji: '🚀',
    user_id: AYSE.id,
  });
  await expect(message.getByRole('button', { name: /🚀: 2 people including you/ })).toBeVisible();
  // Taking it back.
  await message.getByRole('button', { name: /🚀: 2 people/ }).click();
  await expect(message.getByRole('button', { name: /🚀: 1 person\. Add/ })).toBeVisible();
  expect(api.reacted.at(-1)).toBe(`-🚀 ${mockMessage(1, '').id}`);
});
