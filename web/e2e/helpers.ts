// SPDX-License-Identifier: AGPL-3.0-only
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
  // Colors are checked once enter animations (fades) have finished: halfway
  // through, a button is still partly transparent.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
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
/** The instance-wide banner and terms a test can set (see mockSession). */
export const instance: {
  banner: Record<string, unknown> | null;
  terms: { id: string; text: string; created_at: string } | null;
  accepted: boolean;
} = { banner: null, terms: null, accepted: true };

export async function mockSession(page: Page, session: typeof SESSION | null = SESSION) {
  instance.banner = null;
  instance.terms = null;
  instance.accepted = true;
  await page.route('**/api/banner', (route) =>
    route.fulfill({ json: { banner: instance.banner } }),
  );
  await page.route('**/api/terms', (route) =>
    route.fulfill({ json: { terms: instance.terms, accepted: instance.accepted } }),
  );
  await page.route('**/api/terms/accept', (route) => {
    instance.accepted = true;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/meta', (route) => route.fulfill({ json: { web_app: true } }));
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
  kind: 'standard' as 'standard' | 'announcement' | 'direct' | 'group' | 'forum',
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
export const PIXEL = Buffer.from(
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
/** A forum (not in the default lists; pass it with `channels`). */
export const FORUM = channel('01a15e50-4444-7d7d-bbee-8e7809fd8ad2', 'Ideas', {
  kind: 'forum',
  is_default: false,
  forum_tags: ['UX', 'Backend'],
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
  root_id?: string;
  also_in_channel?: boolean;
  pinned_at?: string | null;
  pinned_by?: string | null;
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

export const EMOJI = [
  {
    id: '01a15e50-e000-7000-8000-000000000001',
    name: 'party',
    url: '/api/pictures/01a15e50-e000-7000-8000-0000000000e1',
    created_by: null as string | null,
  },
];

export const STICKERS = [
  {
    id: '01a15e50-5000-7000-8000-000000000001',
    name: 'Wave',
    url: '/api/pictures/01a15e50-5000-7000-8000-0000000000e1',
    created_by: null as string | null,
  },
];

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
  /** Marked unread: "channel id" or "channel id:message id". */
  unreads: string[];
  /** Acknowledgements sent: "PUT <message id>" or "DELETE <message id>". */
  acks: string[];
  /** The person's sidebar arrangement as the fake server keeps it. */
  sidebar: Record<string, unknown>;
  /** Mention groups as the fake server keeps them (with their members). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groups: { group: any; members: { person: any; manager: boolean }[] }[];
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
  /** Reasons of reported messages. */
  reports: string[];
  /** Events, playbooks and AutoMod rules as the fake server keeps them. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any[];
  playbooks: Record<string, unknown>[];
  automod: Record<string, unknown>[];
  /** Notification settings as the fake server keeps them. */
  notifications?: {
    prefs: Record<string, unknown>;
    channels: Record<string, unknown>[];
    workspaces: Record<string, unknown>[];
  };
}

/**
 * A fake chat server in the browser: session, Central, General (with
 * `messages`) and Random, the
 * ticket endpoint and a WebSocket that says hello. Tests run without the
 * Go server.
 */
/** The default permission scheme (what 0.33 allowed). */
const SCHEME = {
  create_channels: ['admin'],
  invite_people: ['admin'],
  manage_categories: ['admin'],
  custom_emoji: ['admin', 'member'],
  broadcast_mentions: ['admin', 'member', 'guest'],
  group_mentions: ['admin', 'member', 'guest'],
};

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
    emoji?: typeof EMOJI;
    stickers?: typeof STICKERS;
    /** The operator configured a model and the workspace turned AI on. */
    ai?: boolean;
    /** The workspace turned read receipts on; how far others read. */
    reads?: { user_id: string; last_read_id: string | null }[];
    /** The permissions of the user's role (the scheme's defaults otherwise). */
    can?: string[];
  } = {},
): Promise<MockApi> {
  await mockSession(page, {
    ...SESSION,
    permissions: {
      create_workspaces: opts.admin ?? false,
      upload_files: opts.files ?? true,
      max_file_size: 104857600,
      ...(opts.ai ? { ai: true } : {}),
    },
  });
  const workspaces = [
    {
      id: DEFAULT_WS,
      name: 'Cenacle',
      description: '',
      icon_url: null as string | null,
      appearance: { preset: 'cenacle', font_template: 'modern' },
      is_default: true,
      role: opts.admin ? 'owner' : 'member',
      ...(opts.ai ? { ai_enabled: true } : {}),
      ...(opts.reads ? { read_receipts: true } : {}),
      permissions: { ...SCHEME } as Record<string, string[]>,
      can:
        opts.can ??
        (opts.admin
          ? Object.keys(SCHEME)
          : ['custom_emoji', 'broadcast_mentions', 'group_mentions']),
    },
  ];
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/permissions$/, (route) => {
    const id = route.request().url().split('/').at(-2)!;
    const ws = workspaces.find((w) => w.id === id)!;
    const { permissions } = route.request().postDataJSON() as {
      permissions: Record<string, string[]>;
    };
    ws.permissions = { ...SCHEME, ...permissions };
    return route.fulfill({ json: ws });
  });
  // Workflows and forms (v0.21): none unless a test adds them.
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/shortcuts$/, (route) =>
    route.fulfill({ json: { workflows: [], forms: [] } }),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/(forms|workflows|tasks)$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const kind = route.request().url().split('/').pop()!;
    return route.fulfill({ json: { [kind]: [] } });
  });
  // Servers channels are shared with (v0.25): none unless a test adds them.
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/shares$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { shares: [] } }) : route.fallback(),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/federation$/, (route) =>
    route.fulfill({ json: { connections: [], offers: [] } }),
  );
  // Classification banners (v0.23): none unless a test adds them.
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/classifications$/, (route) =>
    route.fulfill({ json: { classifications: [], default_id: null } }),
  );
  // Channel tabs and rows assigned to the user (v0.22): none unless a test adds them.
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/tabs$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { tabs: [] } }) : route.fallback(),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/assigned-items$/, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  // Custom emoji and stickers of the workspace (v0.20).
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/emoji$/, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { emoji: opts.emoji ?? [] } })
      : route.fallback(),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/stickers$/, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { stickers: opts.stickers ?? [] } })
      : route.fallback(),
  );
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
      appearance: { preset: 'cenacle', font_template: 'modern' },
      is_default: false,
      role: 'owner',
      permissions: { ...SCHEME } as Record<string, string[]>,
      can: Object.keys(SCHEME),
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
    unreads: [],
    acks: [],
    sidebar: { order: [], sections: [], placements: {}, group_unreads: false, collapsed: [] },
    groups: [],
    reacted: [],
    typing: [],
    statuses: [],
    ended: [],
    reports: [],
    events: [],
    playbooks: [],
    automod: [],
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
      // Like events: kept until the app has connected (a busy machine connects late).
      const frame = JSON.stringify({ op: 'ephemeral', type, data });
      if (this.socket) this.socket.send(frame);
      else this.pending.push(frame);
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
  // As the server does: messages carry the summary of their replies.
  const withThread = (m: (typeof stored)[number]) => {
    const { deleted: _, ...out } = m;
    const replies = stored.filter((r) => !r.deleted && r.root_id === m.id);
    if (m.root_id || replies.length === 0) return out;
    const authors = [...new Map(replies.toReversed().map((r) => [r.author.id, r.author])).values()];
    return {
      ...out,
      thread: {
        reply_count: replies.length,
        last_reply_at: replies.at(-1)!.created_at,
        participants: authors.slice(0, 3),
      },
    };
  };
  const follows = new Map<string, { following: boolean; last_read_id: string | null }>();
  const saved: Record<string, unknown>[] = [];
  const searchChannelOf = (id: string) => {
    const c = all.find((x) => x.id === id)!;
    return { id: c.id, name: c.name, kind: c.kind, workspace_id: c.workspace_id };
  };
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/ack$/, (route) => {
    api.acks.push(
      `${route.request().method()} ${route.request().url().split('/messages/')[1]!.split('/')[0]}`,
    );
    return route.fulfill({ status: 204 });
  });
  const edits: Record<string, { body: string; written_at: string; replaced_at: string }[]> = {};
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/edits$/, (route) => {
    const id = route.request().url().split('/messages/')[1]!.split('/')[0]!;
    return route.fulfill({ json: { edits: edits[id] ?? [] } });
  });
  await page.route(
    /\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}(\/restore)?$/,
    (route) => {
      const req = route.request();
      const id = req.url().split('/messages/')[1]!.split('/')[0]!;
      const m = stored.find((x) => x.id === id)!;
      if (req.method() === 'PATCH') {
        const body = (req.postDataJSON() as { body: string }).body;
        if (body !== m.body) {
          const versions = (edits[m.id] ??= []);
          versions.unshift({
            body: m.body,
            written_at: m.edited_at ?? m.created_at,
            replaced_at: new Date().toISOString(),
          });
        }
        m.body = body;
        m.edited_at = new Date().toISOString();
      } else if (req.method() === 'DELETE') {
        m.deleted = true;
        return route.fulfill({ status: 204 });
      } else if (req.method() === 'GET') {
        return route.fulfill({ json: withThread(m) });
      } else {
        m.deleted = false;
      }
      return route.fulfill({ json: withThread(m) });
    },
  );
  await page.route('**/api/channels/*/messages*', async (route) => {
    const channelId = route.request().url().split('/api/channels/')[1]!.split('/')[0]!;
    if (route.request().method() === 'GET') {
      const params = new URL(route.request().url()).searchParams;
      const before = params.get('before');
      const limit = Number(params.get('limit') ?? 50);
      const page = stored
        .filter(
          (m) =>
            !m.deleted &&
            m.channel_id === channelId &&
            (!m.root_id || m.also_in_channel) &&
            (!before || m.id < before),
        )
        .map(withThread);
      // Oldest first; a page is the newest `limit` before the cursor.
      return route.fulfill({
        json: { messages: page.slice(-limit), has_more: page.length > limit },
      });
    }
    if (failures > 0) {
      failures--;
      return route.abort('internetdisconnected');
    }
    const input = route.request().postDataJSON() as {
      body: string;
      nonce: string;
      root_id?: string;
      also_in_channel?: boolean;
      title?: string;
      tags?: string[];
      poll?: { options: string[]; multiple?: boolean; anonymous?: boolean };
      sticker_id?: string;
      burn_seconds?: number;
      priority?: string;
      request_ack?: boolean;
      persistent?: boolean;
    };
    api.sent.push(input);
    const message = {
      ...mockMessage(1000 + api.sent.length, input.body, SESSION.user.display_name),
      author: { id: SESSION.user.id, display_name: SESSION.user.display_name },
      channel_id: channelId,
      nonce: input.nonce,
      ...(input.root_id
        ? { root_id: input.root_id, also_in_channel: !!input.also_in_channel }
        : {}),
      ...(input.title ? { title: input.title, tags: input.tags ?? [] } : {}),
      ...(input.sticker_id
        ? {
            sticker: {
              ...(STICKERS.find((s) => s.id === input.sticker_id) ?? STICKERS[0]),
            },
          }
        : {}),
      ...(input.burn_seconds
        ? { burn: { seconds: input.burn_seconds, revealed_at: null, hidden: false } }
        : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.request_ack ? { ack: { count: 0, me: false, people: [] } } : {}),
      ...(input.persistent ? { persistent: true } : {}),
      ...(input.poll
        ? {
            poll: {
              options: input.poll.options.map((text, i) => ({
                id: `01a15e50-0000-7000-9000-${String(i).padStart(12, '0')}`,
                text,
                votes: 0,
                me: false,
                voters: [],
              })),
              multiple: !!input.poll.multiple,
              anonymous: !!input.poll.anonymous,
              closes_at: null,
              closed: false,
              voters: 0,
            },
          }
        : {}),
      // As the server does: <@id> of known people become mentions.
      mentions: PEOPLE.filter((p) => input.body.includes(`<@${p.id}>`)).map((p) => ({
        id: p.id,
        display_name: p.display_name,
      })),
    };
    stored.push({ ...message, deleted: false });
    // Replying makes one follow the thread.
    if (input.root_id && !follows.has(input.root_id)) {
      follows.set(input.root_id, { following: true, last_read_id: message.id });
    }
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
    const { message_id = 'newest' } = route.request().postDataJSON() as { message_id?: string };
    api.reads.set(c.id, message_id);
    if (message_id !== 'newest') c.last_read_id = message_id;
    c.unread_count = 0;
    c.mention_count = 0;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/channels/*/reads', (route) =>
    route.fulfill({ json: { enabled: !!opts.reads, reads: opts.reads ?? [] } }),
  );
  await page.route('**/api/channels/*/unread', (route) => {
    const c = channelOf(route.request().url());
    const { message_id } = route.request().postDataJSON() as { message_id?: string };
    api.unreads.push(message_id ? `${c.id}:${message_id}` : c.id);
    c.unread_count = Math.max(c.unread_count, 1);
    return route.fulfill({ status: 204 });
  });
  const groupSelf = {
    id: SESSION.user.id,
    display_name: SESSION.user.display_name,
    email: SESSION.user.email,
  };
  const groupView = (g: MockApi['groups'][number]) => ({
    ...g.group,
    member_count: g.members.length,
    is_member: g.members.some((m) => m.person.id === groupSelf.id),
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/mention-groups$/, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { groups: api.groups.map(groupView), can_create: true, creation: 'members' },
      });
    }
    const body = route.request().postDataJSON() as {
      handle: string;
      name: string;
      description?: string;
      member_ids?: string[];
    };
    if (api.groups.some((g) => g.group.handle === body.handle)) {
      return route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        json: { status: 409, code: 'handle_taken', title: 'Conflict' },
      });
    }
    const id = `01a15e50-9999-7000-8000-${String(api.groups.length).padStart(12, '0')}`;
    const group = {
      id,
      handle: body.handle,
      name: body.name,
      description: body.description ?? '',
      directory_group: null,
      can_manage: true,
      archived: false,
    };
    const others = PEOPLE.filter((p) => body.member_ids?.includes(p.id));
    api.groups.push({
      group,
      members: [
        { person: groupSelf, manager: true },
        ...others.map((p) => ({ person: p, manager: false })),
      ],
    });
    return route.fulfill({ status: 201, json: groupView(api.groups.at(-1)!) });
  });
  await page.route(/\/api\/mention-groups\/[0-9a-f-]{36}(\/.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const [, , , id, , userId] = url.pathname.split('/');
    const g = api.groups.find((x) => x.group.id === id);
    if (!g) return route.fulfill({ status: 404, json: { status: 404 } });
    const method = route.request().method();
    if (url.pathname.endsWith('/members') && method === 'POST') {
      const { user_ids } = route.request().postDataJSON() as { user_ids: string[] };
      for (const p of PEOPLE.filter((x) => user_ids.includes(x.id))) {
        if (!g.members.some((m) => m.person.id === p.id))
          g.members.push({ person: p, manager: false });
      }
      return route.fulfill({ status: 204 });
    }
    if (userId && method === 'DELETE') {
      g.members = g.members.filter((m) => m.person.id !== userId);
      return route.fulfill({ status: 204 });
    }
    if (userId && method === 'PATCH') {
      const { manager } = route.request().postDataJSON() as { manager: boolean };
      g.members = g.members.map((m) => (m.person.id === userId ? { ...m, manager } : m));
      return route.fulfill({ status: 204 });
    }
    if (method === 'PATCH') {
      Object.assign(g.group, route.request().postDataJSON());
      return route.fulfill({ json: groupView(g) });
    }
    return route.fulfill({ json: { group: groupView(g), members: g.members } });
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/sidebar$/, (route) => {
    if (route.request().method() === 'PUT') {
      api.sidebar = route.request().postDataJSON() as Record<string, unknown>;
    }
    return route.fulfill({ json: api.sidebar });
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
  // Notification settings, sounds and web push.
  const notifications = {
    prefs: {
      desktop: false,
      push: false,
      sounds: { message: 'none', mention: 'chime', direct: 'bell' },
      volume: 70,
      default_level: 'all',
      email: { enabled: false, delay_minutes: 15 },
      paused_until: null as string | null,
      quiet_hours: { enabled: false, start: '22:00', end: '08:00', days: [1, 2, 3, 4, 5] },
    },
    channels: [] as Record<string, unknown>[],
    workspaces: [] as Record<string, unknown>[],
    email_available: true,
    push_public_key: null as string | null,
  };
  api.notifications = notifications;
  await page.route('**/api/me/notifications', (route) => {
    if (route.request().method() === 'PUT') notifications.prefs = route.request().postDataJSON();
    return route.fulfill({ json: notifications });
  });
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/notifications$/, (route) => {
    const id = route.request().url().split('/').at(-2)!;
    const n = { channel_id: id, ...route.request().postDataJSON() };
    notifications.channels = [...notifications.channels.filter((c) => c.channel_id !== id), n];
    return route.fulfill({ json: n });
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/notifications$/, (route) => {
    const id = route.request().url().split('/').at(-2)!;
    const n = { workspace_id: id, ...route.request().postDataJSON() };
    notifications.workspaces = [
      ...notifications.workspaces.filter((w) => w.workspace_id !== id),
      n,
    ];
    return route.fulfill({ json: n });
  });
  await page.route('**/api/me/sounds**', (route) => route.fulfill({ json: { sounds: [] } }));
  // Search: words that begin words of the message, newest first.
  await page.route('**/api/search/messages?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const words = (params.get('q') ?? '').toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
    const results = stored
      .filter((m) => !m.deleted)
      .filter((m) =>
        words.every((w) =>
          m.body
            .toLocaleLowerCase('tr')
            .split(/[^\p{L}\p{N}_]+/u)
            .some((x) => x.startsWith(w)),
        ),
      )
      .toReversed()
      .map(({ deleted: _, ...m }) => {
        const ch = all.find((c) => c.id === m.channel_id)!;
        return {
          id: m.id,
          channel: { id: ch.id, name: ch.name, kind: ch.kind, workspace_id: ch.workspace_id },
          author: m.author,
          body: m.body,
          created_at: m.created_at,
          has_files: m.files.length > 0,
        };
      });
    return route.fulfill({ json: { results, has_more: false } });
  });
  await page.route('**/api/search/files?**', (route) =>
    route.fulfill({ json: { results: [], has_more: false } }),
  );
  // Threads, pins, saved messages, activity and unreads.
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/replies/, (route) => {
    const root = route.request().url().split('/messages/')[1]!.split('/')[0]!;
    const replies = stored.filter((m) => !m.deleted && m.root_id === root).map(withThread);
    return route.fulfill({ json: { messages: replies, has_more: false } });
  });
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/pin$/, (route) => {
    const id = route.request().url().split('/messages/')[1]!.split('/')[0]!;
    const m = stored.find((x) => x.id === id)!;
    const pin = route.request().method() === 'PUT';
    m.pinned_at = pin ? new Date().toISOString() : null;
    m.pinned_by = pin ? SESSION.user.id : null;
    return route.fulfill({ json: withThread(m) });
  });
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/pins$/, (route) => {
    const channelId = route.request().url().split('/api/channels/')[1]!.split('/')[0]!;
    return route.fulfill({
      json: {
        messages: stored
          .filter((m) => !m.deleted && m.channel_id === channelId && m.pinned_at)
          .map(withThread),
      },
    });
  });
  await page.route(/\/api\/me\/threads(\?.*)?$/, (route) => {
    const threads = stored
      .filter((m) => !m.deleted && follows.get(m.id)?.following)
      .map((m) => {
        const replies = stored.filter((r) => !r.deleted && r.root_id === m.id);
        const read = follows.get(m.id)!.last_read_id;
        return {
          root: withThread(m),
          channel: searchChannelOf(m.channel_id),
          unread_count: replies.filter(
            (r) => r.author.id !== SESSION.user.id && (!read || r.id > read),
          ).length,
          mention_count: 0,
          last_reply_id: replies.at(-1)?.id ?? m.id,
        };
      });
    return route.fulfill({ json: { threads, has_more: false } });
  });
  await page.route(/\/api\/me\/threads\/unread/, (route) =>
    route.fulfill({ json: { threads: 0, mentions: 0 } }),
  );
  await page.route(/\/api\/me\/threads\/[0-9a-f-]{36}(\/read)?$/, (route) => {
    const req = route.request();
    const id = req.url().split('/api/me/threads/')[1]!.split('/')[0]!;
    const state = follows.get(id) ?? { following: false, last_read_id: null };
    if (req.method() === 'PUT') {
      state.following = (req.postDataJSON() as { following: boolean }).following;
      follows.set(id, state);
      return route.fulfill({ status: 204 });
    }
    if (req.method() === 'POST') {
      state.last_read_id = (req.postDataJSON() as { message_id: string }).message_id;
      follows.set(id, state);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: state });
  });
  await page.route('**/api/me/saved', (route) => route.fulfill({ json: { items: saved } }));
  await page.route(/\/api\/me\/saved\/[0-9a-f-]{36}$/, (route) => {
    const req = route.request();
    const id = req.url().split('/').pop()!;
    const at = saved.findIndex((s) => (s.message as { id: string }).id === id);
    if (at >= 0) saved.splice(at, 1);
    if (req.method() === 'DELETE') return route.fulfill({ status: 204 });
    const m = stored.find((x) => x.id === id)!;
    const state = req.postDataJSON() as { remind_at?: string | null; done?: boolean };
    const item = {
      message: withThread(m),
      channel: searchChannelOf(m.channel_id),
      saved_at: new Date().toISOString(),
      remind_at: state.done ? null : (state.remind_at ?? null),
      done_at: state.done ? new Date().toISOString() : null,
    };
    saved.unshift(item);
    return route.fulfill({ json: item });
  });
  await page.route(/\/api\/me\/activity/, (route) =>
    route.fulfill({ json: { items: [], has_more: false } }),
  );
  await page.route(/\/api\/me\/unreads/, (route) => route.fulfill({ json: { channels: [] } }));
  // Community and moderation.
  await page.route(
    /\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/poll\/votes$/,
    (route) => {
      const id = route.request().url().split('/messages/')[1]!.split('/')[0]!;
      const m = stored.find((x) => x.id === id) as unknown as {
        poll: Record<string, unknown> & { options: { id: string; votes: number; me: boolean }[] };
      };
      const chosen = (route.request().postDataJSON() as { option_ids: string[] }).option_ids;
      m.poll.options = m.poll.options.map((o) => {
        const was = o.me ? 1 : 0;
        const now = chosen.includes(o.id) ? 1 : 0;
        return { ...o, me: now === 1, votes: o.votes - was + now };
      });
      m.poll.voters = chosen.length ? 1 : 0;
      return route.fulfill({ json: m.poll });
    },
  );
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/report$/, (route) => {
    api.reports.push((route.request().postDataJSON() as { reason: string }).reason);
    return route.fulfill({ status: 204 });
  });
  await page.route(/\/api\/channels\/[0-9a-f-]{36}\/runs$/, (route) =>
    route.fulfill({ json: { runs: [] } }),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/welcome$/, (route) =>
    route.fulfill({ json: { message: '', rules: [], channel_ids: [] } }),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/events$/, (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      const e = {
        id: `01a15e50-eeee-7000-8000-${String(api.events.length).padStart(12, '0')}`,
        workspace_id: DEFAULT_WS,
        channel_id: input.channel_id ?? null,
        title: input.title,
        description: input.description ?? '',
        location: input.location ?? '',
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        created_by: { id: SESSION.user.id, display_name: SESSION.user.display_name },
        canceled: false,
        going: [],
        maybe: 0,
        me: null,
        can_edit: true,
      };
      api.events.push(e);
      return route.fulfill({ status: 201, json: e });
    }
    return route.fulfill({ json: { events: api.events } });
  });
  await page.route(/\/api\/events\/[0-9a-f-]{36}\/rsvp$/, (route) => {
    const id = route.request().url().split('/api/events/')[1]!.split('/')[0]!;
    const e = api.events.find((x) => x.id === id)!;
    const status = (route.request().postDataJSON() as { status: string | null }).status;
    e.me = status;
    e.going =
      status === 'going' ? [{ id: SESSION.user.id, display_name: SESSION.user.display_name }] : [];
    return route.fulfill({ json: e });
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/playbooks$/, (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      const p = {
        id: `01a15e50-bbbb-7000-8000-${String(api.playbooks.length).padStart(12, '0')}`,
        description: '',
        updated_at: new Date().toISOString(),
        runs_active: 0,
        ...input,
      };
      api.playbooks.push(p);
      return route.fulfill({ status: 201, json: p });
    }
    return route.fulfill({ json: { playbooks: api.playbooks } });
  });
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/runs$/, (route) =>
    route.fulfill({ json: { runs: [] } }),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/reports/, (route) =>
    route.fulfill({ json: { reports: [] } }),
  );
  await page.route(/\/api\/workspaces\/[0-9a-f-]{36}\/automod$/, (route) => {
    if (route.request().method() === 'POST') {
      const rule = {
        id: '01a15e50-aaaa-7000-8000-00000000a001',
        words: [],
        max_mentions: 5,
        allowed_domains: [],
        exempt_roles: ['owner', 'admin'],
        enabled: true,
        ...(route.request().postDataJSON() as object),
      };
      api.automod.push(rule);
      return route.fulfill({ status: 201, json: rule });
    }
    return route.fulfill({ json: { rules: api.automod } });
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
