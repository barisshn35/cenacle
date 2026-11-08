// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_WS,
  GENERAL,
  expectNoAxeViolations,
  expectTargetSizes,
  mockApi,
  mockMessage,
  composerTool,
} from './helpers';

const composer = (page: Page) => page.getByLabel('Message General');

const COMMANDS = [
  {
    trigger: 'remind',
    description: 'Get a reminder from Cenacle',
    hint: 'me in 10m …',
    builtin: true,
  },
  { trigger: 'shrug', description: 'Add ¯\\_(ツ)_/¯', hint: 'text', builtin: true },
  { trigger: 'deploy', description: 'Deploy a service', hint: 'service env', builtin: false },
];

async function mockCommands(page: Page) {
  const runs: { command: string; text: string; timezone: string }[] = [];
  const scheduled: Record<string, unknown>[] = [];
  await page.route(`**/api/workspaces/${DEFAULT_WS}/commands`, (route) =>
    route.fulfill({ json: { commands: COMMANDS } }),
  );
  await page.route(`**/api/channels/${GENERAL.id}/commands`, (route) => {
    const input = route.request().postDataJSON() as (typeof runs)[number];
    runs.push(input);
    if (input.command === 'nope') {
      return route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: { status: 404, code: 'unknown_command', title: 'Not Found' },
      });
    }
    if (input.command === 'shrug') {
      return route.fulfill({
        json: {
          response_type: 'in_channel',
          message: mockMessage(40, `${input.text} ¯\\\\\\_(ツ)\\_/¯`, 'Deniz Acar'),
        },
      });
    }
    return route.fulfill({
      json: { response_type: 'ephemeral', text: `I will remind you: **${input.text}**` },
    });
  });
  await page.route(`**/api/channels/${GENERAL.id}/scheduled`, (route) => {
    const { body, send_at } = route.request().postDataJSON() as { body: string; send_at: string };
    const item = {
      id: `01a15e50-5c4e-7000-8000-00000000000${scheduled.length}`,
      kind: 'message',
      channel_id: GENERAL.id,
      channel_name: 'General',
      workspace_id: DEFAULT_WS,
      body,
      send_at,
    };
    scheduled.push(item);
    return route.fulfill({ status: 201, json: item });
  });
  await page.route('**/api/scheduled', (route) => route.fulfill({ json: { scheduled } }));
  await page.route(/\/api\/scheduled\/[0-9a-f-]{36}$/, (route) => {
    scheduled.splice(0);
    return route.fulfill({ status: 204 });
  });
  return { runs };
}

test('slash commands: suggestions, answers only for you, messages in the channel', async ({
  page,
}, testInfo) => {
  await mockApi(page);
  const { runs } = await mockCommands(page);
  await page.goto('/');

  await composer(page).fill('/');
  const list = page.getByRole('listbox', { name: 'Commands' });
  await expect(list.getByRole('option')).toHaveCount(3);
  await composer(page).pressSequentially('re');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expectTargetSizes(page, testInfo, 'footer');
  await expectNoAxeViolations(page, 'footer');
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('/remind ');

  await composer(page).pressSequentially('me in 10m stand up');
  await composer(page).press('Enter');
  const note = page.getByTestId('command-note');
  await expect(note).toContainText('Only you see this · /remind');
  await expect(note.locator('strong')).toHaveText('me in 10m stand up');
  expect(runs[0]).toMatchObject({ command: 'remind', text: 'me in 10m stand up' });
  expect(runs[0]!.timezone).toBeTruthy();
  await expect(composer(page)).toHaveValue('');
  await note.getByRole('button', { name: 'Dismiss' }).click();
  await expect(note).toHaveCount(0);

  await composer(page).fill('/shrug olur');
  await composer(page).press('Enter');
  await expect(page.getByRole('log').getByText('olur ¯\\_(ツ)_/¯')).toBeVisible();

  await composer(page).fill('/nope');
  await composer(page).press('Enter');
  await expect(page.getByTestId('command-note')).toContainText('There is no /nope command here');

  // "//" sends the text as a message.
  await composer(page).fill('//etc/hosts dosyası');
  await composer(page).press('Enter');
  await expect(page.getByRole('log').getByText('/etc/hosts dosyası')).toBeVisible();
  expect(runs).toHaveLength(3);
});

test('a message can be sent later and cancelled', async ({ page }, testInfo) => {
  // Two dialogs with accessibility scans: under the load of the whole suite on
  // the touch project it came close to the default 30 s.
  test.slow();
  await mockApi(page);
  await mockCommands(page);
  await page.goto('/');
  await composer(page).fill('Haftalık özet');
  await composerTool(page, 'Send later');
  const dialog = page.getByRole('dialog', { name: 'Send later' });
  await expect(dialog.getByText('Nothing scheduled.')).toBeVisible();
  await expectTargetSizes(page, testInfo, '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: /Tomorrow morning/ }).click();
  await expect(page.getByText(/^Scheduled for /)).toBeVisible();
  await expect(composer(page)).toHaveValue('');

  await composerTool(page, 'Send later');
  await expect(dialog.getByTestId('scheduled')).toContainText('Haftalık özet');
  await expect(dialog.getByTestId('scheduled')).toContainText('General');
  await dialog.getByRole('button', { name: /Cancel the message for/ }).click();
  await expect(dialog.getByText('Nothing scheduled.')).toBeVisible();
});

// On a narrow screen a toast spans the width; it must sit above the composer
// and leave every control on screen uncovered.
for (const [lang, locale, sendLater, tomorrow, scheduled] of [
  ['EN', 'en-US', 'Send later', /Tomorrow morning/, /^Scheduled for /],
  ['TR', 'tr-TR', 'Sonra gönder', /Yarın sabah/, / için zamanlandı\.$/],
] as const) {
  for (const viewport of [
    { width: 412, height: 839 },
    { width: 360, height: 640 },
    { width: 320, height: 568 },
  ]) {
    test.describe(`toast on a ${viewport.width}×${viewport.height} screen (${lang})`, () => {
      test.use({ viewport, locale, hasTouch: true });

      test('sits above the composer and covers no control', async ({ page }, testInfo) => {
        // The viewport and touch are set here; one project is enough.
        test.skip(testInfo.project.name !== 'coarse');
        await mockApi(page);
        await mockCommands(page);
        await page.goto('/');
        const input = page.locator('footer textarea');
        await input.fill('Haftalık özet');
        await composerTool(page, sendLater);
        await page.getByRole('dialog').getByRole('button', { name: tomorrow }).click();
        const toast = page.locator('[data-sonner-toast]').filter({ hasText: scheduled });
        await expect(toast).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        // Wait for the toast to finish sliding in: two equal readings in a row.
        let last = -1;
        await expect
          .poll(async () => {
            const y = (await toast.boundingBox())?.y ?? -1;
            const settled = y === last;
            last = y;
            return settled;
          })
          .toBe(true);
        const box = (await toast.boundingBox())!;
        const footer = (await page.locator('footer').last().boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
        const covered = await page.evaluate((t) => {
          const hits: string[] = [];
          const controls = document.querySelectorAll<HTMLElement>(
            'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"]',
          );
          for (const el of controls) {
            if (el.closest('[data-sonner-toaster]')) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
            const overlaps =
              r.left < t.x + t.width && r.right > t.x && r.top < t.y + t.height && r.bottom > t.y;
            if (overlaps)
              hits.push(el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName);
          }
          return hits;
        }, box);
        expect(covered).toEqual([]);
      });
    });
  }
}
