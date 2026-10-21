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
  permissions: { create_channels: false },
  created_at: '2026-10-21T08:00:00Z',
  expires_at: '2026-11-20T08:00:00Z',
  idle_timeout_seconds: 604800,
};

/**
 * Answers the session API in the browser, so app tests run without the chat
 * server: signed in (default) or signed out (null).
 */
export async function mockSession(page: Page, session: typeof SESSION | null = SESSION) {
  await page.unroute('**/api/session');
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

const channel = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  topic: '',
  kind: 'standard' as 'standard' | 'announcement',
  visibility: 'public' as 'public' | 'private',
  is_default: true,
  is_mandatory: false,
  is_member: true,
  can_post: true,
  can_manage: false,
  ...extra,
});

/** People of the fake server (the signed-in user first). */
export const PEOPLE = [
  {
    id: '01a15dab-33d6-722d-aa40-6f2370b89146',
    display_name: 'Deniz Kaya',
    email: 'deniz@example.com',
  },
  {
    id: '01a15e50-aaaa-7000-8000-000000000001',
    display_name: 'Ayşe Yılmaz',
    email: 'ayse@example.com',
  },
  {
    id: '01a15e50-aaaa-7000-8000-000000000002',
    display_name: 'Mert Kaya',
    email: 'mert@example.com',
  },
];

export const CENTRAL = channel('01a15e50-1111-7d7d-bbee-8e7809fd8ad2', 'Central', {
  topic: 'Announcements for everyone.',
  kind: 'announcement',
  is_mandatory: true,
  can_post: false,
});
export const GENERAL = channel('01a15e50-2335-7d7d-bbee-8e7809fd8ad2', 'General', {
  topic: 'Anything and everything.',
});
export const RANDOM = channel('01a15e50-3333-7d7d-bbee-8e7809fd8ad2', 'Random', {
  is_default: false,
  is_member: false,
});

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
 * A fake chat server in the browser: session, Central, General (with
 * `messages`) and Random, the
 * ticket endpoint and a WebSocket that says hello. Tests run without the
 * Go server.
 */
export async function mockApi(
  page: Page,
  opts: { messages?: MockMessage[]; failSend?: number; admin?: boolean } = {},
): Promise<MockApi> {
  await mockSession(page, { ...SESSION, permissions: { create_channels: opts.admin ?? false } });
  const api: MockApi & { socket?: import('@playwright/test').WebSocketRoute; seq: number } = {
    sent: [],
    seq: 1,
    emit(type, data) {
      this.seq++;
      this.socket?.send(JSON.stringify({ op: 'event', id: `${this.seq}-0`, type, data }));
    },
  };
  let failures = opts.failSend ?? 0;
  // Membership as the fake server keeps it.
  const admin = opts.admin ?? false;
  const all = [CENTRAL, GENERAL, RANDOM].map((c) => ({ ...c, can_manage: admin }));
  // channel id -> member ids (manager first)
  const members = new Map<string, { id: string; role: 'member' | 'manager' }[]>(
    all.map((c) => [c.id, [{ id: PEOPLE[0]!.id, role: 'member' }]]),
  );
  const channelOf = (url: string) => all.find((x) => url.includes(x.id))!;
  await page.route('**/api/channels', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { channels: all.filter((c) => c.is_member) } });
    }
    const input = route.request().postDataJSON() as {
      name: string;
      topic?: string;
      is_default?: boolean;
      visibility?: 'public' | 'private';
    };
    if (all.some((c) => c.name.toLowerCase() === input.name.toLowerCase())) {
      return route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'channel_name_taken',
        }),
      });
    }
    const id = `01a15e50-9999-7d7d-bbee-${String(all.length).padStart(12, '0')}`;
    const created = channel(id, input.name, {
      topic: input.topic ?? '',
      is_default: input.is_default ?? false,
      visibility: input.visibility ?? 'public',
      can_manage: true,
    });
    all.push(created);
    members.set(id, [{ id: PEOPLE[0]!.id, role: 'manager' }]);
    return route.fulfill({ status: 201, json: created });
  });
  await page.route('**/api/channels/directory', (route) =>
    route.fulfill({ json: { channels: all } }),
  );
  await page.route('**/api/channels/*/join', (route) => {
    const c = channelOf(route.request().url());
    c.is_member = true;
    return route.fulfill({ json: c });
  });
  await page.route(/\/api\/channels\/[0-9a-f-]{36}$/, (route) => {
    const c = channelOf(route.request().url());
    Object.assign(c, route.request().postDataJSON());
    return route.fulfill({ json: c });
  });
  await page.route('**/api/channels/*/members**', (route) => {
    const req = route.request();
    const c = channelOf(req.url());
    const list = members.get(c.id)!;
    if (req.method() === 'POST') {
      const { user_id } = req.postDataJSON() as { user_id: string };
      if (!list.some((m) => m.id === user_id)) list.push({ id: user_id, role: 'member' });
    } else if (req.method() === 'DELETE') {
      const id = req.url().split('/').pop()!;
      members.set(
        c.id,
        list.filter((m) => m.id !== id),
      );
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        members: members
          .get(c.id)!
          .map((m) => ({ user: PEOPLE.find((p) => p.id === m.id)!, role: m.role })),
      },
    });
  });
  await page.route('**/api/users?**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')!.toLowerCase();
    return route.fulfill({
      json: {
        users: PEOPLE.filter((p) => `${p.display_name} ${p.email}`.toLowerCase().includes(q)),
      },
    });
  });
  await page.route('**/api/channels/*/leave', (route) => {
    const c = channelOf(route.request().url());
    c.is_member = false;
    return route.fulfill({ status: 204 });
  });
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
