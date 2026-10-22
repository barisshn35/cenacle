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
  permissions: { create_workspaces: false, upload_files: true, max_file_size: 104857600 },
  created_at: '2026-10-21T08:00:00Z',
  expires_at: '2026-11-20T08:00:00Z',
  idle_timeout_seconds: 604800,
  account_url: 'http://localhost:8190/account?return_to=http%3A%2F%2Flocalhost%3A15173%2F',
};

/** Signed-in devices of the fake server (the first one is this browser). */
export const DEVICES = [
  {
    id: '01a15e50-5e55-7000-8000-000000000001',
    created_at: '2026-10-21T08:00:00Z',
    last_seen_at: '2026-10-21T09:00:00Z',
    user_agent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 OPR/125.0',
    ip_address: '10.0.0.5',
    current: true,
  },
  {
    id: '01a15e50-5e55-7000-8000-000000000002',
    created_at: '2026-10-20T08:00:00Z',
    last_seen_at: '2026-10-20T18:00:00Z',
    user_agent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1',
    ip_address: '10.0.0.9',
    current: false,
  },
  {
    id: '01a15e50-5e55-7000-8000-000000000003',
    created_at: '2026-10-19T08:00:00Z',
    last_seen_at: '2026-10-19T12:00:00Z',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    ip_address: '',
    current: false,
  },
];

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

export const DEFAULT_WS = '01a15e50-0000-7000-8000-00000000aaaa';

const channel = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  workspace_id: DEFAULT_WS,
  name,
  topic: '',
  kind: 'standard' as 'standard' | 'announcement' | 'direct' | 'group',
  visibility: 'public' as 'public' | 'private',
  is_default: true,
  is_mandatory: false,
  is_member: true,
  can_post: true,
  can_manage: false,
  group_managed: false,
  archived: false,
  category_id: null as string | null,
  unread_count: 0,
  mention_count: 0,
  last_read_id: null as string | null,
  participants: [] as { id: string; display_name: string; email: string }[],
  ...extra,
});

/** A direct conversation of the signed-in user with one of PEOPLE. */
export function directWith(person: (typeof PEOPLE)[number], extra: Record<string, unknown> = {}) {
  return channel(`01a15e50-dddd-7000-8000-${person.id.slice(-12)}`, `direct:${person.id}`, {
    kind: 'direct',
    visibility: 'private',
    is_default: false,
    participants: [person],
    ...extra,
  });
}

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

export type MockChannel = ReturnType<typeof channel>;

export interface MockProfile {
  id: string;
  display_name: string;
  username: string;
  email: string;
  is_bot: boolean;
  avatar_url: string | null;
  avatar_still_url: string | null;
  timezone: string;
  status: { emoji: string; text: string; expires_at?: string | null } | null;
  last_seen_at: string | null;
  deactivated: boolean;
  guest: boolean;
}

/** The profile of one of PEOPLE. */
export function mockProfile(person: (typeof PEOPLE)[number]): MockProfile {
  return {
    ...person,
    username: person.email.split('@')[0]!,
    is_bot: false,
    avatar_url: null,
    avatar_still_url: null,
    timezone: 'Europe/Istanbul',
    status: null,
    last_seen_at: null,
    deactivated: false,
    guest: false,
  };
}

/** A 1×1 PNG (for pictures). */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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
  mentions: { id: string; display_name: string }[];
  reactions: { emoji: string; count: number; me: boolean }[];
  attachments: Record<string, unknown>[];
  files: Record<string, unknown>[];
  edited_at: string | null;
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
    edited_at: null as string | null,
    mentions: [],
    reactions: [],
    attachments: [],
    files: [],
  };
}

/** Handle to the fake chat server of a test. */
export interface MockApi {
  /** Sends an event over the open WebSocket. */
  emit(type: string, data: unknown): void;
  /** Sends a short-lived notice (typing, presence) over the open WebSocket. */
  emitEphemeral(type: string, data: unknown): void;
  /** Bodies of POSTed messages. */
  sent: { body: string; nonce: string }[];
  /** Reactions sent: "+👍" or "-👍" with the message id. */
  reacted: string[];
  /** Read positions sent: channel id -> message id. */
  reads: Map<string, string>;
  /** Channels typing notices were sent for. */
  typing: string[];
  /** Statuses the user chose. */
  statuses: string[];
  /** Requests to end sessions: an id, or "all"/"others". */
  ended: string[];
  /** Profiles by id as the fake server keeps them (tests may change them). */
  profiles: Record<string, MockProfile>;
  /** Closes the WebSocket from the server side. */
  closeSocket(code: number): void;
}

/**
 * A fake chat server in the browser: session, Central, General (with
 * `messages`) and Random, the
 * ticket endpoint and a WebSocket that says hello. Tests run without the
 * Go server.
 */
export async function mockApi(
  page: Page,
  opts: {
    messages?: MockMessage[];
    failSend?: number;
    admin?: boolean;
    /** More channels the user is in (conversations), with changes to the defaults. */
    channels?: MockChannel[];
    general?: Partial<MockChannel>;
    presence?: { user_id: string; status: string }[];
    /** Whether the server stores files (default: yes). */
    files?: boolean;
  } = {},
): Promise<MockApi> {
  await mockSession(page, {
    ...SESSION,
    permissions: {
      create_workspaces: opts.admin ?? false,
      upload_files: opts.files ?? true,
      max_file_size: 104857600,
    },
  });
  const workspaces = [
    {
      id: DEFAULT_WS,
      name: 'Cenacle',
      description: '',
      icon_url: null as string | null,
      appearance: { preset: 'cenacle', font_template: 'corporate' },
      is_default: true,
      role: opts.admin ? 'owner' : 'member',
    },
  ];
  // The details panel lists the channel's files.
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/files$/, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { files: [], has_more: false } })
      : route.fallback(),
  );
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { workspaces } });
    const { name } = route.request().postDataJSON() as { name: string };
    const ws = {
      id: `01a15e50-0000-7000-8000-0000000${String(workspaces.length).padStart(5, '0')}`,
      name,
      description: '',
      icon_url: null,
      appearance: { preset: 'cenacle', font_template: 'corporate' },
      is_default: false,
      role: 'owner',
    };
    workspaces.push(ws);
    return route.fulfill({ status: 201, json: ws });
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}$/, (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const id = route.request().url().split('/').pop()!;
    const ws = workspaces.find((w) => w.id === id)!;
    Object.assign(ws, route.request().postDataJSON());
    return route.fulfill({ json: ws });
  });
  await page.route('**/api/workspaces/*/members', (route) =>
    route.fulfill({
      json: {
        members: PEOPLE.map((p, i) => ({
          user: p,
          role: i === 0 ? (opts.admin ? 'owner' : 'member') : 'member',
        })),
      },
    }),
  );
  // Appearance, uploaded fonts and the interface texts administrators replaced.
  let appearance: Record<string, unknown> = {
    theme: 'system',
    preset: 'workspace',
    density: 'auto',
    fonts: { template: 'workspace', text: 'inter', code: 'jetbrains-mono' },
    font_size: 14,
    line_height: 'normal',
    code: { theme: 'github', line_numbers: false, wrap: false, ligatures: true },
  };
  await page.route('**/api/me/appearance', (route) => {
    if (route.request().method() === 'PUT') appearance = route.request().postDataJSON();
    return route.fulfill({ json: appearance });
  });
  const fonts: { id: string; name: string; format: string; size: number; created_at: string }[] =
    [];
  await page.route('**/api/me/fonts**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const font = {
        id: `01a15e50-f0f0-7000-8000-${String(fonts.length).padStart(12, '0')}`,
        name: new URL(req.url()).searchParams.get('name') ?? 'Font',
        format: 'woff2',
        size: 100,
        created_at: new Date().toISOString(),
      };
      fonts.push(font);
      return route.fulfill({ status: 201, json: font });
    }
    if (req.method() === 'DELETE') {
      fonts.splice(0, 1);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { fonts } });
  });
  const uiTexts: Record<string, Record<string, string>> = {};
  await page.route('**/api/ui-texts', (route) => {
    if (route.request().method() === 'PUT') {
      const { locale, texts } = route.request().postDataJSON() as {
        locale: string;
        texts: Record<string, string>;
      };
      uiTexts[locale] = Object.fromEntries(Object.entries(texts).filter(([, v]) => v));
    }
    return route.fulfill({
      json: {
        texts: uiTexts,
        editable: [
          'auth.title',
          'auth.subtitle',
          'auth.continue',
          'auth.help',
          'shell.channelStart',
          'shell.composerPlaceholder',
        ],
      },
    });
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/appearance$/, (route) => {
    const id = route.request().url().split('/').at(-2)!;
    const ws = workspaces.find((w) => w.id === id)!;
    ws.appearance = route.request().postDataJSON();
    return route.fulfill({ json: ws });
  });
  // Profiles, one's own profile and pictures.
  const recent: { emoji: string; text: string }[] = [];
  const self = () => api.profiles[SESSION.user.id]!;
  const myProfile = () => ({
    ...self(),
    username_editable: true,
    show_last_seen: true,
    recent_statuses: recent,
    account_url: SESSION.account_url,
  });
  await page.route(/\/api\/profiles\?/, (route) => {
    const ids = new URL(route.request().url()).searchParams.get('ids')?.split(',') ?? [];
    return route.fulfill({
      json: { profiles: ids.map((id) => api.profiles[id]).filter(Boolean) },
    });
  });
  await page.route('**/api/me/profile', (route) => {
    if (route.request().method() === 'PATCH') {
      Object.assign(self(), route.request().postDataJSON());
    }
    return route.fulfill({ json: myProfile() });
  });
  await page.route('**/api/me/status', (route) => {
    if (route.request().method() === 'DELETE') {
      self().status = null;
      return route.fulfill({ status: 204 });
    }
    const st = route.request().postDataJSON() as { emoji: string; text: string };
    self().status = st;
    recent.unshift({ emoji: st.emoji, text: st.text });
    return route.fulfill({ json: myProfile() });
  });
  await page.route('**/api/me/avatar', (route) => {
    self().avatar_url = route.request().method() === 'DELETE' ? null : '/api/pictures/me';
    return route.request().method() === 'DELETE'
      ? route.fulfill({ status: 204 })
      : route.fulfill({ json: myProfile() });
  });
  await page.route('**/api/pictures/*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  // A channel's directory groups.
  const channelGroups = new Map<string, { groups: string[]; managed: boolean }>();
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/groups$/, (route) => {
    const req = route.request();
    const id = req.url().split('/').at(-2)!;
    if (req.method() === 'PUT') {
      channelGroups.set(id, req.postDataJSON() as { groups: string[]; managed: boolean });
    }
    return route.fulfill({ json: channelGroups.get(id) ?? { groups: [], managed: false } });
  });
  // Directory groups mapped to workspaces (Cenacle ID's groups).
  const mappings: { group: string; role: string }[] = [];
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/groups(\/[^/]+)?$/, (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ json: { mappings, groups: ['design', 'engineering', 'staff'] } });
    }
    if (req.method() === 'DELETE') {
      const name = decodeURIComponent(req.url().split('/').pop()!);
      mappings.splice(
        mappings.findIndex((m) => m.group === name),
        1,
      );
      return route.fulfill({ status: 204 });
    }
    const m = req.postDataJSON() as { group: string; role: string };
    const at = mappings.findIndex((x) => x.group === m.group);
    if (at >= 0) mappings[at] = m;
    else mappings.push(m);
    return route.fulfill({ json: m });
  });
  const invites: {
    id: string;
    created_at: string;
    expires_at: string;
    max_uses: number | null;
    uses: number;
  }[] = [];
  await page.route('**/api/workspaces/*/invites', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { invites } });
    const { max_uses } = route.request().postDataJSON() as { max_uses: number | null };
    const invite = {
      id: `01a15e50-ab00-7000-8000-${String(invites.length).padStart(12, '0')}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      max_uses,
      uses: 0,
    };
    invites.push(invite);
    return route.fulfill({ status: 201, json: { invite, token: `token${invites.length}` } });
  });
  const api: MockApi & {
    socket?: import('@playwright/test').WebSocketRoute;
    seq: number;
    pending: string[];
  } = {
    sent: [],
    reads: new Map(),
    reacted: [],
    typing: [],
    statuses: [],
    ended: [],
    profiles: Object.fromEntries(PEOPLE.map((p) => [p.id, mockProfile(p)])),
    seq: 1,
    // Events sent before the app connected: delivered after the hello.
    pending: [],
    emit(type, data) {
      if (type === 'channel.read') {
        // As the server would: a reload after this shows the channel read.
        const { channel_id } = data as { channel_id: string };
        const c = all.find((x) => x.id === channel_id);
        if (c) c.unread_count = 0;
      }
      this.seq++;
      const frame = JSON.stringify({ op: 'event', id: `${this.seq}-0`, type, data });
      if (this.socket) this.socket.send(frame);
      else this.pending.push(frame);
    },
    closeSocket(code) {
      void this.socket?.close({ code, reason: '' });
    },
    emitEphemeral(type, data) {
      this.socket?.send(JSON.stringify({ op: 'ephemeral', type, data }));
    },
  };
  let failures = opts.failSend ?? 0;
  // Membership as the fake server keeps it.
  const admin = opts.admin ?? false;
  const all: MockChannel[] = [
    CENTRAL,
    { ...GENERAL, ...opts.general },
    RANDOM,
    ...(opts.channels ?? []),
  ].map((c) => ({ ...c, can_manage: admin && c.kind !== 'direct' && c.kind !== 'group' }));
  // channel id -> member ids (manager first)
  const members = new Map<string, { id: string; role: 'member' | 'manager' }[]>(
    all.map((c) => [c.id, [{ id: PEOPLE[0]!.id, role: 'member' }]]),
  );
  const channelOf = (url: string) => all.find((x) => url.includes(x.id))!;
  await page.route('**/api/channels', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { channels: all.filter((c) => c.is_member && !c.archived) } });
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
  const categories: { id: string; name: string; position: number }[] = [];
  await page.route('**/api/categories?**', (route) => route.fulfill({ json: { categories } }));
  await page.route('**/api/categories', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { categories } });
    const { name } = route.request().postDataJSON() as { name: string };
    const c = {
      id: `01a15e50-cccc-7000-8000-${String(categories.length).padStart(12, '0')}`,
      name,
      position: categories.length,
    };
    categories.push(c);
    return route.fulfill({ status: 201, json: c });
  });
  await page.route('**/api/channels/*/category', (route) => {
    const c = channelOf(route.request().url());
    c.category_id = (route.request().postDataJSON() as { category_id: string | null }).category_id;
    return route.fulfill({ json: c });
  });
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/(un)?archive$/, (route) => {
    const c = channelOf(route.request().url());
    c.archived = !route.request().url().endsWith('/unarchive');
    return route.fulfill({ json: c });
  });
  await page.route('**/api/channels/directory?**', (route) =>
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
  // Messages of General, as stored; deleted ones keep a flag for restoring.
  const stored = (opts.messages ?? []).map((m) => ({ ...m, deleted: false }));
  await page.route(
    /\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}(\/restore)?$/,
    (route) => {
      const req = route.request();
      const id = req.url().split('/messages/')[1]!.split('/')[0]!;
      const m = stored.find((x) => x.id === id)!;
      if (req.method() === 'PATCH') {
        m.body = (req.postDataJSON() as { body: string }).body;
        m.edited_at = new Date().toISOString();
      } else if (req.method() === 'DELETE') {
        m.deleted = true;
        return route.fulfill({ status: 204 });
      } else {
        m.deleted = false;
      }
      const { deleted: _, ...out } = m;
      return route.fulfill({ json: out });
    },
  );
  await page.route('**/api/channels/*/messages*', async (route) => {
    const channelId = route.request().url().split('/api/channels/')[1]!.split('/')[0]!;
    if (route.request().method() === 'GET') {
      const list = stored
        .filter((m) => !m.deleted && m.channel_id === channelId)
        .map(({ deleted: _, ...m }) => m);
      return route.fulfill({ json: { messages: list, has_more: false } });
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
      channel_id: channelId,
      nonce: input.nonce,
      // As the server does: <@id> of known people become mentions.
      mentions: PEOPLE.filter((p) => input.body.includes(`<@${p.id}>`)).map((p) => ({
        id: p.id,
        display_name: p.display_name,
      })),
    };
    stored.push({ ...message, deleted: false });
    return route.fulfill({ status: 201, json: message });
  });
  await page.route('**/api/workspaces/*/conversations', (route) => {
    const { user_ids } = route.request().postDataJSON() as { user_ids: string[] };
    const person = PEOPLE.find((p) => p.id === user_ids[0])!;
    let c = all.find((x) => x.kind === 'direct' && x.participants[0]?.id === person.id);
    const created = !c;
    if (!c) {
      c = directWith(person);
      all.push(c);
      members.set(c.id, [
        { id: PEOPLE[0]!.id, role: 'member' },
        { id: person.id, role: 'member' },
      ]);
    }
    return route.fulfill({ status: created ? 201 : 200, json: c });
  });
  await page.route('**/api/workspaces/*/presence', (route) =>
    route.fulfill({ json: { presence: opts.presence ?? [] } }),
  );
  await page.route('**/api/presence', (route) => {
    api.statuses.push((route.request().postDataJSON() as { status: string }).status);
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/channels/*/read', (route) => {
    const c = channelOf(route.request().url());
    const { message_id } = route.request().postDataJSON() as { message_id: string };
    api.reads.set(c.id, message_id);
    c.last_read_id = message_id;
    c.unread_count = 0;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/channels/*/typing', (route) => {
    api.typing.push(channelOf(route.request().url()).id);
    return route.fulfill({ status: 204 });
  });
  let devices = [...DEVICES];
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: devices } }));
  await page.route('**/api/sessions/end-all', (route) => {
    const { keep_current } = route.request().postDataJSON() as { keep_current: boolean };
    api.ended.push(keep_current ? 'others' : 'all');
    const ended = devices.filter((d) => !keep_current || !d.current).length;
    devices = devices.filter((d) => keep_current && d.current);
    return route.fulfill({ json: { ended } });
  });
  await page.route(/\/api\/sessions\/[0-9a-f-]{36}$/, (route) => {
    const id = route.request().url().split('/').pop()!;
    api.ended.push(id);
    devices = devices.filter((d) => d.id !== id);
    return route.fulfill({ status: 204 });
  });
  await page.route(/\/messages\/[0-9a-f-]{36}\/reactions\/[^/]+$/, (route) => {
    const req = route.request();
    const [, id, emoji] = /messages\/([0-9a-f-]{36})\/reactions\/([^/]+)$/.exec(req.url())!;
    api.reacted.push(`${req.method() === 'PUT' ? '+' : '-'}${decodeURIComponent(emoji!)} ${id}`);
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/ws/ticket', (route) =>
    route.fulfill({ status: 201, json: { ticket: 'test-ticket', expires_in: 30 } }),
  );
  await page.routeWebSocket('**/ws?*', (ws) => {
    api.socket = ws;
    ws.send(JSON.stringify({ op: 'hello', last_event_id: '1-0', heartbeat_ms: 25000 }));
    for (const frame of api.pending.splice(0)) ws.send(frame);
  });
  return api;
}
