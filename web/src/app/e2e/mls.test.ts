// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The MLS client against an in-memory delivery service with the server's
 * rules: devices, epochs (first commit wins), joins, stale devices. Each
 * "browser" is a fresh module with its own IndexedDB.
 */
import { IDBFactory } from 'fake-indexeddb';
import { decodeMlsMessage } from 'ts-mls';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Dev {
  id: string;
  user_id: string;
  name: string;
  signature_key: string;
  created_at: string;
  revoked_at?: string | null;
}

class Problem extends Error {
  constructor(
    public status: number,
    public problem: { code: string },
  ) {
    super(problem.code);
  }
}

/** The delivery service (shared by every browser). */
const ds = {
  devices: [] as Dev[],
  groups: new Map<string, { epoch: number; group_info: string; members: Map<string, number> }>(),
  commits: new Map<string, { epoch: number; data: string; device_id: string }[]>(),
  channelMembers: new Map<string, Set<string>>(),
  reset() {
    this.devices = [];
    this.groups.clear();
    this.commits.clear();
    this.channelMembers.clear();
  },
};
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function serve(user: string, path: string, init?: RequestInit): unknown {
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const method = init?.method ?? 'GET';
  let m: RegExpExecArray | null;
  if (path === '/api/e2e/devices' && method === 'POST') {
    const d: Dev = {
      id: uuid(),
      user_id: user,
      name: body.name,
      signature_key: body.signature_key,
      created_at: new Date().toISOString(),
    };
    ds.devices.push(d);
    return d;
  }
  if ((m = /^\/api\/users\/([^/]+)\/e2e\/devices$/.exec(path))) {
    return { devices: ds.devices.filter((d) => d.user_id === m![1]) };
  }
  const own = (id: string) => {
    const d = ds.devices.find((x) => x.id === id && x.user_id === user && !x.revoked_at);
    if (!d) throw new Problem(403, { code: 'unknown_device' });
    return d;
  };
  if ((m = /^\/api\/channels\/([^/]+)\/e2e(\/commits)?(\?from_epoch=(\d+))?$/.exec(path))) {
    const channel = m[1]!;
    if (!ds.channelMembers.get(channel)?.has(user))
      throw new Problem(403, { code: 'not_a_member' });
    let g = ds.groups.get(channel);
    const view = () => ({
      epoch: g!.epoch,
      group_info: g!.group_info,
      members: [...g!.members].map(([device_id, joined_epoch]) => {
        const d = ds.devices.find((x) => x.id === device_id)!;
        return {
          device_id,
          user_id: d.user_id,
          joined_epoch,
          stale: !!d.revoked_at || !ds.channelMembers.get(channel)!.has(d.user_id),
        };
      }),
    });
    if (!m[2] && method === 'POST') {
      own(body.device_id);
      g = { epoch: 0, group_info: body.group_info, members: new Map([[body.device_id, 0]]) };
      ds.groups.set(channel, g);
      ds.commits.set(channel, []);
      return view();
    }
    if (!g) throw new Problem(404, { code: 'not_found' });
    if (!m[2]) return view();
    if (method === 'GET') {
      const from = Number(m[4]);
      return { commits: ds.commits.get(channel)!.filter((c) => c.epoch >= from) };
    }
    own(body.device_id);
    if (!body.joined && !g.members.has(body.device_id))
      throw new Problem(403, { code: 'unknown_device' });
    if (body.epoch !== g.epoch) throw new Problem(409, { code: 'epoch_conflict' });
    ds.commits.get(channel)!.push({ epoch: g.epoch, data: body.commit, device_id: body.device_id });
    g.epoch++;
    g.group_info = body.group_info;
    for (const id of body.removed ?? []) g.members.delete(id);
    if (body.joined) g.members.set(body.device_id, g.epoch);
    return view();
  }
  throw new Error(`unexpected ${method} ${path}`);
}

function apiFor(user: string) {
  class ApiError extends Error {
    constructor(public problem: { code: string }) {
      super(problem.code);
    }
  }
  return {
    ApiError,
    apiFetch: async (path: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 0));
      try {
        return structuredClone(serve(user, path, init));
      } catch (err) {
        if (err instanceof Problem) throw new ApiError(err.problem);
        throw err;
      }
    },
  };
}

/** What the server does with a message: only envelopes of the current epoch. */
function post(envelope: string): Promise<string> {
  const raw = Uint8Array.from(atob(envelope.slice('mls:v1:'.length)), (c) => c.charCodeAt(0));
  const msg = decodeMlsMessage(raw, 0)![0];
  if (msg.wireformat !== 'mls_private_message') throw new Error('not a private message');
  if (Number(msg.privateMessage.epoch) !== ds.groups.get(CH)!.epoch) {
    return Promise.reject(
      Object.assign(new Error('stale'), { problem: { code: 'epoch_conflict' } }),
    );
  }
  return Promise.resolve(envelope);
}

type Engine = typeof import('./mls');

/** A browser of a person: its own IndexedDB and module state. */
async function browser(user: string): Promise<Engine> {
  vi.resetModules();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
  vi.doMock('@cenacle/core/api', () => apiFor(user));
  return import('./mls');
}

const AYSE = '11111111-1111-4111-8111-111111111111';
const MERT = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';

describe('MLS client', () => {
  beforeEach(() => {
    ds.reset();
    ds.channelMembers.set(CH, new Set([AYSE, MERT]));
  });

  it('turns on encryption, joins devices, sends, removes', { timeout: 20_000 }, async () => {
    const ayse = await browser(AYSE);
    const mertDesk = await browser(MERT);
    const mertLaptop = await browser(MERT);

    await ayse.enable(CH, AYSE);
    expect(ds.groups.get(CH)!.epoch).toBe(0);

    // Mert's desktop joins when it first sends.
    const e1 = await mertDesk.seal(CH, MERT, { v: 1, t: 'Merhaba Ayşe' });
    expect(e1.startsWith('mls:v1:')).toBe(true);
    expect(ds.groups.get(CH)!.epoch).toBe(1);
    expect(await ayse.open(CH, AYSE, e1)).toEqual({ payload: { v: 1, t: 'Merhaba Ayşe' } });
    // Opened once, kept: the second time comes from this device.
    expect(await ayse.open(CH, AYSE, e1)).toEqual({ payload: { v: 1, t: 'Merhaba Ayşe' } });

    // Ayşe answers; the laptop joins later and cannot read what came before.
    const e2 = await ayse.seal(CH, AYSE, { v: 1, t: 'Selam Mert' });
    expect(await mertDesk.open(CH, MERT, e2)).toEqual({ payload: { v: 1, t: 'Selam Mert' } });
    expect(await mertLaptop.open(CH, MERT, e2)).toEqual({ unavailable: 'before' });
    // Ayşe's group is a step behind: the server refuses her envelope and she
    // seals it again for the epoch the laptop is in.
    const e3 = await ayse.send(CH, AYSE, { v: 1, t: 'Yeni cihaz da görsün' }, post);
    expect(await mertLaptop.open(CH, MERT, e3)).toEqual({
      payload: { v: 1, t: 'Yeni cihaz da görsün' },
    });
    expect(await mertDesk.open(CH, MERT, e3)).toEqual({
      payload: { v: 1, t: 'Yeni cihaz da görsün' },
    });

    // Mert removes his desktop: the next commit takes it out of the group.
    const desk = ds.devices.find((d) => d.user_id === MERT)!;
    desk.revoked_at = new Date().toISOString();
    await ayse.sync(CH, AYSE);
    expect([...ds.groups.get(CH)!.members.keys()]).not.toContain(desk.id);
    const e4 = await ayse.seal(CH, AYSE, { v: 1, t: 'Sadece dizüstü' });
    expect(await mertLaptop.open(CH, MERT, e4)).toEqual({ payload: { v: 1, t: 'Sadece dizüstü' } });

    // Mert leaves the channel: his laptop goes too; he cannot read new messages.
    ds.channelMembers.get(CH)!.delete(MERT);
    await ayse.sync(CH, AYSE);
    expect(ds.groups.get(CH)!.members.size).toBe(1);
    const e5 = await ayse.seal(CH, AYSE, { v: 1, t: 'Gizli' });
    ds.channelMembers.get(CH)!.add(MERT); // even if he reads the envelope later
    const left = await mertLaptop.open(CH, MERT, e5);
    expect('payload' in left && left.payload.t === 'Gizli').toBe(false);
  });

  it(
    'two devices racing for the same epoch both end up in the group',
    { timeout: 20_000 },
    async () => {
      const ayse = await browser(AYSE);
      const mert = await browser(MERT);
      const ayse2 = await browser(AYSE);
      await ayse.enable(CH, AYSE);
      const [a, b] = await Promise.all([
        mert.seal(CH, MERT, { v: 1, t: 'bir' }),
        ayse2.seal(CH, AYSE, { v: 1, t: 'iki' }),
      ]);
      expect(ds.groups.get(CH)!.members.size).toBe(3);
      expect(await ayse.open(CH, AYSE, a)).toEqual({ payload: { v: 1, t: 'bir' } });
      expect(await ayse.open(CH, AYSE, b)).toEqual({ payload: { v: 1, t: 'iki' } });
    },
  );

  it('a forged credential does not verify', async () => {
    const ayse = await browser(AYSE);
    await ayse.ensureDevice(AYSE);
    const [dev] = ds.devices;
    expect(ayse.parseIdentity(new TextEncoder().encode(`${AYSE}:${dev!.id}`))).toEqual({
      userId: AYSE,
      deviceId: dev!.id,
    });
    expect(ayse.parseIdentity(new TextEncoder().encode('not-an-identity'))).toBeNull();
    expect(await ayse.fingerprint(new Uint8Array(32))).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  });
});
