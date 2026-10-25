// SPDX-License-Identifier: AGPL-3.0-only
// The checks of the accessibility conformance report (docs/accessibility) that
// a rule engine cannot make: keyboard use, focus, reflow, text spacing, motion
// and what screen readers are told.
import { expect, type Page, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { GENERAL, mockApi, mockMessage } from './helpers';

async function openGeneral(page: Page) {
  const api = await mockApi(page);
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('General');
  return api;
}

/** What the focused element looks like: is the focus visible, is it covered? */
function focusState(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const indicated =
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== 'none' ||
      // A focused text box shows its caret and its own ring on the wrapper.
      el.isContentEditable ||
      el.matches('input, textarea') ||
      // Rows of a list show focus as a change of background.
      el.matches('[data-focus-row]');
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(x, y);
    const covered = !!top && !el.contains(top) && !top.contains(el);
    return {
      label: `<${el.tagName.toLowerCase()}> ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)}`,
      indicated,
      covered,
    };
  });
}

test.describe('keyboard', () => {
  test.skip(({ isMobile }) => isMobile, 'keyboard checks run with a keyboard');

  test('the first Tab offers a way past the navigation to the message box (2.4.1)', async ({
    page,
  }) => {
    await openGeneral(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the message box' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Message General' })).toBeFocused();
  });

  test('every stop of Tab shows focus, is not covered, and the order cycles (2.1.2, 2.4.7, 2.4.11)', async ({
    page,
  }) => {
    await openGeneral(page);
    const problems: string[] = [];
    const seen: string[] = [];
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('Tab');
      const state = await focusState(page);
      if (!state) break;
      if (!state.indicated) problems.push(`no visible focus: ${state.label}`);
      if (state.covered) problems.push(`covered: ${state.label}`);
      seen.push(state.label);
    }
    expect(problems).toEqual([]);
    // Focus moves through the whole page and comes back around: no trap.
    expect(seen.length).toBeGreaterThan(10);
    expect(new Set(seen).size).toBeLessThan(120);
  });

  test('a message can be written and sent with the keyboard alone (2.1.1)', async ({ page }) => {
    const api = await openGeneral(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Klavyeyle yazıldı');
    await page.keyboard.press('Enter');
    await expect.poll(() => api.sent.map((m) => m.body)).toEqual(['Klavyeyle yazıldı']);
  });

  test('a dialog takes focus and gives it back where it was (2.4.3)', async ({ page }) => {
    await openGeneral(page);
    const settings = page.getByRole('button', { name: 'Settings' });
    await settings.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settings).toBeFocused();
  });
});

test('content reflows at 320 CSS pixels without scrolling sideways (1.4.10)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openGeneral(page);
  await expect(page.getByRole('textbox', { name: 'Message General' })).toBeVisible();
  const width = await page.evaluate(() => document.scrollingElement!.scrollWidth);
  expect(width).toBeLessThanOrEqual(320);
});

test('text spacing can be raised without losing content (1.4.12)', async ({ page }) => {
  const api = await openGeneral(page);
  api.emit('message.created', mockMessage(7, 'Satır aralığı büyüdüğünde de okunur', 'Mert Kaya'));
  await page.addStyleTag({
    content: `* { line-height: 1.5 !important; letter-spacing: 0.12em !important;
      word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }`,
  });
  const message = page.getByTestId('message').filter({ hasText: 'Satır aralığı' });
  await expect(message).toBeVisible();
  const clipped = await message.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('*')).some((n) => {
      const s = getComputedStyle(n);
      return (
        s.overflow === 'hidden' &&
        !s.textOverflow.includes('ellipsis') &&
        n.scrollHeight > n.clientHeight + 1 &&
        n.textContent!.trim().length > 0
      );
    }),
  );
  expect(clipped).toBe(false);
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement!.scrollWidth,
    clientWidth: document.scrollingElement!.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test('with reduced motion nothing moves for longer than an instant (2.3.3)', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the settings button is in the drawer on phones');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGeneral(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  const long = await page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => Number(a.effect?.getComputedTiming().duration ?? 0))
      .filter((d) => d > 1),
  );
  expect(long).toEqual([]);
});

test('new messages from others are told to screen readers, older ones are not (4.1.3)', async ({
  page,
}) => {
  const api = await openGeneral(page);
  const log = page.getByRole('log', { name: /General/ });
  await expect(log).toHaveAttribute('aria-live', 'off');
  const announcer = page.getByTestId('announcer');
  await expect(announcer).toHaveText('');
  api.emit('message.created', mockMessage(9, 'Toplantı saat üçte', 'Mert Kaya'));
  await expect(announcer).toHaveText('New message from Mert Kaya: Toplantı saat üçte');
  await expect(announcer).toHaveAttribute('role', 'status');
});

test('in forced colors the shell keeps its structure and passes axe (1.4.11)', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openGeneral(page);
  await expect(page.getByRole('textbox', { name: 'Message General' })).toBeVisible();
  // The browser draws everything in the system's colors then, unless a part
  // opts out; axe's contrast rule reads the authored colors, so it is left out
  // here and the opt-outs are checked instead.
  const optedOut = await page.evaluate(() =>
    Array.from(document.querySelectorAll('body *'))
      .filter((el) => getComputedStyle(el).forcedColorAdjust === 'none')
      .map((el) => el.tagName),
  );
  expect(optedOut).toEqual([]);
  const { violations } = await new AxeBuilder({ page })
    .options({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});
