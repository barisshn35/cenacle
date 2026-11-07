// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { GENERAL, expectNoAxeViolations, expectTargetSizes, mockApi, mockMessage } from './helpers';

const composer = (page: Page) => page.getByLabel('Message General');

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const IMAGE = {
  id: '01a15e50-f11e-7000-8000-000000000001',
  name: 'ekran.png',
  content_type: 'image/png',
  size: 120_000,
  width: 1200,
  height: 600,
  has_thumbnail: true,
};
const DOC = {
  id: '01a15e50-f11e-7000-8000-000000000002',
  name: 'rapor.pdf',
  content_type: 'application/pdf',
  size: 2_400_000,
  width: null,
  height: null,
  has_thumbnail: false,
};

async function mockFiles(page: Page) {
  const sent: unknown[] = [];
  let n = 0;
  await page.route(`**/api/channels/${GENERAL.id}/files`, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          has_more: false,
          files: [
            {
              ...DOC,
              message_id: mockMessage(5, '').id,
              uploader: { id: 'u1', display_name: 'Ayşe Yılmaz' },
              created_at: '2026-10-21T09:05:00Z',
            },
            {
              ...IMAGE,
              message_id: mockMessage(6, '').id,
              uploader: { id: 'u1', display_name: 'Ayşe Yılmaz' },
              created_at: '2026-10-21T09:04:00Z',
            },
          ],
        },
      });
    }
    const { name, size, content_type } = route.request().postDataJSON() as Record<string, string>;
    const file = {
      ...DOC,
      id: `01a15e50-f11e-7000-8000-0000000001${String(n++).padStart(2, '0')}`,
      name,
      size,
      content_type,
    };
    return route.fulfill({
      status: 201,
      json: {
        file,
        upload: { url: '/cenacle-files/', fields: { key: `files/${file.id}`, policy: 'p' } },
      },
    });
  });
  await page.route('**/cenacle-files/', (route) => route.fulfill({ status: 204 }));
  await page.route(/\/api\/files\/[0-9a-f-]{36}\/complete$/, (route) => {
    const id = route.request().url().split('/').at(-2)!;
    return route.fulfill({
      json: { ...DOC, id, name: 'notlar.txt', content_type: 'text/plain', size: 5 },
    });
  });
  await page.route(/\/api\/files\/[0-9a-f-]{36}\/(content|thumbnail)/, (route) =>
    route.fulfill({ body: PNG, contentType: 'image/png' }),
  );
  await page.route(`**/api/channels/${GENERAL.id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as {
      body: string;
      nonce: string;
      file_ids: string[];
    };
    sent.push(body);
    return route.fulfill({
      status: 201,
      json: {
        ...mockMessage(60, body.body, 'Deniz Acar'),
        nonce: body.nonce,
        files: body.file_ids.map((id) => ({
          ...DOC,
          id,
          name: 'notlar.txt',
          content_type: 'text/plain',
          size: 5,
        })),
      },
    });
  });
  return { sent };
}

test('images open in the viewer; other files download', async ({ page }, testInfo) => {
  await mockApi(page, { messages: [{ ...mockMessage(5, 'Ekran ve rapor'), files: [IMAGE, DOC] }] });
  await mockFiles(page);
  await page.goto('/');
  const message = page.getByTestId('message').filter({ hasText: 'Ekran ve rapor' });
  await expect(message.getByTestId('file')).toContainText('rapor.pdf');
  await expect(message.getByRole('link', { name: 'Download rapor.pdf' })).toHaveAttribute(
    'href',
    `/api/files/${DOC.id}/content?download=true`,
  );
  await expectTargetSizes(page, testInfo, '[data-testid="message"]');
  await expectNoAxeViolations(page, '[role="log"]');

  await message.getByRole('button', { name: 'Open ekran.png' }).click();
  const viewer = page.getByRole('dialog', { name: 'ekran.png' });
  await expect(viewer.getByRole('img', { name: 'ekran.png' })).toBeVisible();
  await expect(viewer).toContainText('1200 × 600');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});

test('a small image keeps its size; a large one fits the preview', async ({ page }) => {
  const icon = {
    ...IMAGE,
    id: '01a15e50-f11e-7000-8000-000000000003',
    name: 'ikon.png',
    width: 64,
    height: 64,
  };
  await mockApi(page, {
    messages: [
      { ...mockMessage(5, 'Küçük ikon'), files: [icon] },
      { ...mockMessage(6, 'Büyük ekran'), files: [IMAGE] },
    ],
  });
  await mockFiles(page);
  await page.goto('/');
  const size = async (text: string) =>
    (await page
      .getByTestId('message')
      .filter({ hasText: text })
      .getByTestId('image')
      .boundingBox())!;
  expect(await size('Küçük ikon')).toMatchObject({ width: 64, height: 64 });
  expect(await size('Büyük ekran')).toMatchObject({ width: 320, height: 160 });
});

test('files are attached, uploaded with progress and sent with the message', async ({ page }) => {
  await mockApi(page);
  const { sent } = await mockFiles(page);
  await page.goto('/');
  await page.getByLabel('Attach files', { exact: true }).waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  await (
    await chooser
  ).setFiles({ name: 'notlar.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  const upload = page.getByTestId('upload');
  await expect(upload).toContainText('notlar.txt');
  await expect(upload).toContainText(/5 byte/);
  await composer(page).fill('Notlar ekte');
  await composer(page).press('Enter');
  await expect(page.getByTestId('upload')).toHaveCount(0);
  await expect(
    page.getByTestId('message').filter({ hasText: 'Notlar ekte' }).getByTestId('file'),
  ).toContainText('notlar.txt');
  expect(sent[0]).toMatchObject({ body: 'Notlar ekte', file_ids: [expect.any(String)] });
});

test('a file can be sent without text and removed before sending', async ({ page }) => {
  await mockApi(page);
  const { sent } = await mockFiles(page);
  await page.goto('/');
  const send = page.getByRole('button', { name: 'Send message' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
  ]);
  await expect(page.getByTestId('upload')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove a.txt' }).click();
  await expect(page.getByTestId('upload')).toHaveCount(1);
  await expect(send).toBeEnabled();
  await send.click();
  expect(sent[0]).toMatchObject({ body: '', file_ids: [expect.any(String)] });
});

test('without file storage there is no attach button', async ({ page }) => {
  await mockApi(page, { files: false });
  await page.goto('/');
  await composer(page).waitFor();
  await expect(page.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
});

test('the details panel lists the channel files', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the details panel is a drawer on phones');
  await mockApi(page);
  await mockFiles(page);
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Channel details', exact: true });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const files = page.getByRole('region', { name: 'Files' });
  const rows = files.getByTestId('channel-file');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('rapor.pdf');
  await expect(rows.first()).toContainText('Ayşe Yılmaz');
  // Filter by kind.
  await files.getByRole('radio', { name: /^Documents/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('rapor.pdf');
  await files.getByRole('radio', { name: /^Images/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).not.toContainText('rapor.pdf');
});
