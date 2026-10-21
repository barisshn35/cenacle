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

/** A signed-in session as GET /api/session returns it. */
export const SESSION = {
  user: {
    id: '01a15dab-33d6-722d-aa40-6f2370b89146',
    email: 'deniz@example.com',
    email_verified: true,
    display_name: 'Deniz Kaya',
  },
  created_at: '2026-10-21T08:00:00Z',
  expires_at: '2026-11-20T08:00:00Z',
  idle_timeout_seconds: 604800,
};

/**
 * Answers the session API in the browser, so app tests run without the chat
 * server: signed in (default) or signed out (null).
 */
export async function mockSession(page: Page, session: typeof SESSION | null = SESSION) {
  await page.route('**/api/session', (route) =>
    session
      ? route.fulfill({ json: session, headers: { 'cache-control': 'no-store' } })
      : route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Unauthorized',
            status: 401,
            code: 'unauthenticated',
            request_id: 'REQ-TEST',
          }),
        }),
  );
}

export const GENERAL = {
  id: '01a15e50-2335-7d7d-bbee-8e7809fd8ad2',
  name: 'general',
  topic: 'Anything and everything.',
};

export interface MockMessage {
  id: string;
  channel_id: string;
  author: { id: string; display_name: string };
  body: string;
  nonce: string;
  created_at: string;
}

export function mockMessage(n: number, body: string, author = 'Ayşe Yılmaz'): MockMessage {
  const id = `01a15e50-0000-7000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    channel_id: GENERAL.id,
    author: {
      id: `01a15e50-aaaa-7000-8000-${author.length.toString().padStart(12, '0')}`,
      display_name: author,
    },
    body,
    nonce: `nonce-${n}`,
    created_at: new Date(Date.UTC(2026, 9, 21, 9, n)).toISOString(),
  };
}

/** Handle to the fake chat server of a test. */
export interface MockApi {
  /** Sends an event over the open WebSocket. */
  emit(type: string, data: unknown): void;
  /** Bodies of POSTed messages. */
  sent: { body: string; nonce: string }[];
}

/**
 * A fake chat server in the browser: session, #general with `messages`, the
 * ticket endpoint and a WebSocket that says hello. Tests run without the
 * Go server.
 */
export async function mockApi(
  page: Page,
  opts: { messages?: MockMessage[]; failSend?: number } = {},
): Promise<MockApi> {
  await mockSession(page);
  const api: MockApi & { socket?: import('@playwright/test').WebSocketRoute; seq: number } = {
    sent: [],
    seq: 1,
    emit(type, data) {
      this.seq++;
      this.socket?.send(JSON.stringify({ op: 'event', id: `${this.seq}-0`, type, data }));
    },
  };
  let failures = opts.failSend ?? 0;
  await page.route('**/api/channels', (route) => route.fulfill({ json: { channels: [GENERAL] } }));
  await page.route('**/api/channels/*/messages*', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { messages: opts.messages ?? [], has_more: false } });
    }
    if (failures > 0) {
      failures--;
      return route.abort('internetdisconnected');
    }
    const input = route.request().postDataJSON() as { body: string; nonce: string };
    api.sent.push(input);
    const message = {
      ...mockMessage(1000 + api.sent.length, input.body, SESSION.user.display_name),
      author: { id: SESSION.user.id, display_name: SESSION.user.display_name },
      nonce: input.nonce,
    };
    return route.fulfill({ status: 201, json: message });
  });
  await page.route('**/api/ws/ticket', (route) =>
    route.fulfill({ status: 201, json: { ticket: 'test-ticket', expires_in: 30 } }),
  );
  await page.routeWebSocket('**/ws?*', (ws) => {
    api.socket = ws;
    ws.send(JSON.stringify({ op: 'hello', last_event_id: '1-0', heartbeat_ms: 25000 }));
  });
  return api;
}
