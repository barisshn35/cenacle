// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

export const VARIANTS = [
  { theme: 'light', density: 'comfortable' },
  { theme: 'light', density: 'compact' },
  { theme: 'dark', density: 'comfortable' },
  { theme: 'dark', density: 'compact' },
] as const;

/** Elements a pointer user can activate. */
const INTERACTIVE = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="separator"][tabindex]',
  '[data-target]',
].join(',');

export interface Measured {
  label: string;
  width: number;
  height: number;
}

/**
 * Measures every visible interactive element. The effective size includes a
 * hit area made with ::before/::after (absolutely positioned pseudo-element),
 * which is how visually small controls meet the target size.
 * Elements marked data-target-exempt (inline links, documented equivalents)
 * are skipped, as WCAG 2.5.8 allows.
 */
export async function measureTargets(page: Page, scope = 'body'): Promise<Measured[]> {
  return page
    .locator(scope)
    .first()
    .evaluate((root, selector) => {
      const results: { label: string; width: number; height: number }[] = [];
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
        if (el.closest('[data-target-exempt],[aria-hidden="true"],[inert]')) continue;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (rect.width === 0 && rect.height === 0) continue;
        // Visually hidden (sr-only) helpers are not pointer targets.
        if (rect.width <= 1 && rect.height <= 1 && style.position === 'absolute') continue;

        let width = rect.width;
        let height = rect.height;
        for (const pseudo of ['::before', '::after'] as const) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content === 'none' || ps.position !== 'absolute' || ps.display === 'none')
            continue;
          const w = parseFloat(ps.width);
          const h = parseFloat(ps.height);
          if (Number.isFinite(w) && Number.isFinite(h)) {
            width = Math.max(width, w);
            height = Math.max(height, h);
          }
        }
        const name =
          el.getAttribute('aria-label') ||
          el.textContent?.trim().slice(0, 40) ||
          el.getAttribute('placeholder') ||
          el.id ||
          el.className.toString().slice(0, 40);
        results.push({ label: `<${el.tagName.toLowerCase()}> ${name}`, width, height });
      }
      return results;
    }, INTERACTIVE);
}

export async function isCoarse(page: Page): Promise<boolean> {
  return page.evaluate(() => matchMedia('(pointer: coarse)').matches);
}

/** Fails on any target below the minimum; annotates fine targets below the 28 px goal. */
export async function expectTargetSizes(page: Page, testInfo: TestInfo, scope?: string) {
  // Measure final geometry: open/enter animations (e.g. a dialog's zoom-in)
  // scale elements while they run.
  await page
    .locator(scope ?? 'body')
    .first()
    .evaluate((el) =>
      Promise.all(
        el
          .getAnimations({ subtree: true })
          // Infinite animations (skeleton pulse) never finish; they do not change size.
          .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
  const coarse = await isCoarse(page);
  const min = coarse ? 44 : 24;
  const goal = coarse ? 44 : 28;
  const measured = await measureTargets(page, scope);
  expect(measured.length, 'no interactive elements found').toBeGreaterThan(0);

  const tooSmall = measured.filter((m) => Math.min(m.width, m.height) < min - 0.5);
  const belowGoal = measured.filter(
    (m) => !tooSmall.includes(m) && Math.min(m.width, m.height) < goal - 0.5,
  );
  for (const m of belowGoal) {
    testInfo.annotations.push({
      type: 'warning',
      description: `${m.label} is ${m.width.toFixed(1)}x${m.height.toFixed(1)} (goal ${goal}px)`,
    });
  }
  expect(
    tooSmall.map((m) => `${m.label}: ${m.width.toFixed(1)}x${m.height.toFixed(1)}`),
    `targets below ${min}px (${coarse ? 'coarse' : 'fine'} pointer)`,
  ).toEqual([]);
  return measured.length;
}

/** axe-core with WCAG 2.2 AA rules; target-size is disabled by default in axe, so enable it. */
export async function expectNoAxeViolations(page: Page, include?: string) {
  // Note: .options() replaces runOnly, so the tags are passed here as well.
  let builder = new AxeBuilder({ page }).options({
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'target-size': { enabled: true } },
  });
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

/** Records every request whose host is not the app's own origin. */
export function trackExternalRequests(page: Page): string[] {
  const external: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) external.push(req.url());
  });
  return external;
}
