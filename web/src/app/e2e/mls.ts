// SPDX-License-Identifier: AGPL-3.0-only
/**
 * End-to-end encryption with device keys: the MLS client (RFC 9420, ts-mls).
 *
 * Every device registers an Ed25519 signing key; its credential is
 * "<user id>:<device id>", checked against the keys the server lists for that
 * person. A channel's group holds its members' devices. A device joins on its
 * own with the channel's newest GroupInfo (an external commit), processes the
 * group's commits in order, and removes stale devices (removed ones, those of
 * people who left) with its next commit. Messages are "mls:v1:<MLSMessage>".
 * An MLS message opens once, so the text is kept on this device (db "plain").
 */
import * as mls from 'ts-mls';
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { b64, del, exclusive, get, put, sha256, unb64, wipe } from './db';

export type E2EDevice = components['schemas']['E2EDevice'];
export type MLSGroup = components['schemas']['MLSGroup'];
type MLSCommit = components['schemas']['MLSCommit'];

export const PREFIX = 'mls:v1:';
export const isMLSEnvelope = (body: string) => body.startsWith(PREFIX);

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
let suite: Promise<mls.CiphersuiteImpl> | null = null;
const impl = () => (suite ??= mls.getCiphersuiteImpl(mls.getCiphersuiteFromName(SUITE)));

const enc = new TextEncoder();
const dec = new TextDecoder();

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- this device ------------------------------------------------------------------------

export interface Device {
  id: string;
  userId: string;
  name: string;
  signKey: Uint8Array;
  publicKey: Uint8Array;
}

/** A name for this device people recognize ("Firefox on Linux"). */
export function deviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Electron\//.test(ua)
        ? 'Cenacle Desktop'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} · ${os}` : browser;
}

/** This device for a person: registered once, kept in IndexedDB. */
export function ensureDevice(userId: string): Promise<Device> {
  return exclusive(`device:${userId}`, async () => {
    const known = await get<Device>('device', userId);
    if (known) return known;
    const keys = await (await impl()).signature.keygen();
    const name = deviceName();
    const d = await apiFetch<E2EDevice>(
      '/api/e2e/devices',
      json({ name, signature_key: b64(keys.publicKey) }),
    );
    const device: Device = {
      id: d.id,
      userId,
      name,
      signKey: keys.signKey,
      publicKey: keys.publicKey,
    };
    await put('device', userId, device);
    return device;
  });
}

/**
 * Signing out: the server forgets this device and this browser forgets its
 * keys, group states and what it decrypted (a shared computer keeps nothing).
 * Backups sealed with the recovery key bring the history to the next device.
 */
export async function forgetThisDevice(userId: string): Promise<void> {
  const known = await get<Device>('device', userId).catch(() => undefined);
  if (known) {
    await apiFetch<void>(`/api/e2e/devices/${known.id}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
  await wipe();
}

/** The device the server no longer knows (removed elsewhere): start over. */
async function forgetDevice(userId: string) {
  await del('device', userId);
}

const isUnknownDevice = (err: unknown) =>
  err instanceof ApiError && err.problem.code === 'unknown_device';

/** A short, readable fingerprint of a signing key (to compare in person). */
export async function fingerprint(publicKey: Uint8Array): Promise<string> {
  const digest = await sha256(new Uint8Array(publicKey));
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g)!.join(' ');
}

// --- people's keys (the authentication service) ------------------------------------------

const deviceLists = new Map<string, { at: number; devices: Promise<E2EDevice[]> }>();

export function devicesOf(userId: string, fresh = false): Promise<E2EDevice[]> {
  const cached = deviceLists.get(userId);
  if (cached && !fresh && Date.now() - cached.at < 60_000) return cached.devices;
  const devices = apiFetch<{ devices: E2EDevice[] }>(`/api/users/${userId}/e2e/devices`).then(
    (r) => r.devices,
  );
  deviceLists.set(userId, { at: Date.now(), devices });
  devices.catch(() => deviceLists.delete(userId));
  return devices;
}

const identity = (userId: string, deviceId: string) => enc.encode(`${userId}:${deviceId}`);

/** "<user>:<device>" of a credential. */
export function parseIdentity(id: Uint8Array): { userId: string; deviceId: string } | null {
  const m = /^([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(dec.decode(id));
  return m ? { userId: m[1]!, deviceId: m[2]! } : null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** A credential is valid when the server lists that key for that device of that person. */
async function validCredential(credential: mls.Credential, key: Uint8Array): Promise<boolean> {
  if (credential.credentialType !== 'basic') return false;
  const who = parseIdentity(credential.identity);
  if (!who) return false;
  for (const refetch of [false, true]) {
    const devices = await devicesOf(who.userId, refetch);
    const d = devices.find((x) => x.id === who.deviceId);
    if (d && sameBytes(unb64(d.signature_key), key)) return true;
  }
  return false;
}

const config: mls.ClientConfig = {
  ...defaultClientConfig,
  authService: { validateCredential: validCredential },
};

// --- groups -------------------------------------------------------------------------------

interface Saved {
  state: Uint8Array;
  /** The epoch this device joined at: older messages are not for it. */
  joined: string;
}

const wire = (m: mls.MLSMessage) => mls.encodeMlsMessage(m);
const unwire = (b: Uint8Array) => {
  const out = mls.decodeMlsMessage(b, 0);
  if (!out) throw new Error('not an MLS message');
  return out[0];
};

async function load(channelId: string): Promise<{ state: mls.ClientState; joined: bigint } | null> {
  const saved = await get<Saved>('groups', channelId);
  if (!saved) return null;
  const decoded = mls.decodeGroupState(saved.state, 0);
  if (!decoded) return null;
  return { state: { ...decoded[0], clientConfig: config }, joined: BigInt(saved.joined) };
}

async function save(channelId: string, state: mls.ClientState, joined: bigint) {
  await put('groups', channelId, {
    state: mls.encodeGroupState(state),
    joined: joined.toString(),
  } satisfies Saved);
}

async function groupInfoOf(state: mls.ClientState): Promise<string> {
  const gi = await mls.createGroupInfoWithExternalPubAndRatchetTree(state, [], await impl());
  return b64(wire({ groupInfo: gi, wireformat: 'mls_group_info', version: 'mls10' }));
}

async function keyPackage(device: Device) {
  const cred: mls.Credential = {
    credentialType: 'basic',
    identity: identity(device.userId, device.id),
  };
  return mls.generateKeyPackageWithKey(
    cred,
    mls.defaultCapabilities(),
    mls.defaultLifetime,
    [],
    { signKey: device.signKey, publicKey: device.publicKey },
    await impl(),
  );
}

const groupAPI = (channelId: string) => `/api/channels/${channelId}/e2e`;

/** Turns on encryption with device keys for a channel (its first device makes the group). */
export async function enable(channelId: string, userId: string): Promise<void> {
  const device = await ensureDevice(userId);
  const kp = await keyPackage(device);
  const state = await mls.createGroup(
    enc.encode(channelId),
    kp.publicPackage,
    kp.privatePackage,
    [],
    await impl(),
    config,
  );
  await exclusive(channelId, async () => {
    await apiFetch<MLSGroup>(
      groupAPI(channelId),
      json({ device_id: device.id, group_info: await groupInfoOf(state) }),
    );
    await save(channelId, state, 0n);
  });
  fresh.add(channelId);
}

/**
 * When this device last brought a channel's group up to date. Events say
 * when it changes; without one for 30 s the group is checked again anyway.
 */
const synced = new Map<string, number>();
const fresh = {
  has: (id: string) => Date.now() - (synced.get(id) ?? 0) < 30_000,
  add: (id: string) => void synced.set(id, Date.now()),
  delete: (id: string) => void synced.delete(id),
};

/** Something changed in a channel's group (an event): update it soon. */
export function groupChanged(channelId: string, userId: string) {
  fresh.delete(channelId);
  // A little spread, so that members' devices do not all commit at once.
  setTimeout(() => void sync(channelId, userId).catch(() => undefined), Math.random() * 1500);
}

async function postCommit(
  channelId: string,
  device: Device,
  epoch: bigint,
  commit: Uint8Array,
  state: mls.ClientState,
  extra: { joined?: boolean; removed?: string[] },
): Promise<boolean> {
  try {
    await apiFetch<MLSGroup>(
      `${groupAPI(channelId)}/commits`,
      json({
        device_id: device.id,
        epoch: Number(epoch),
        commit: b64(commit),
        group_info: await groupInfoOf(state),
        ...extra,
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.problem.code === 'epoch_conflict') return false;
    throw err;
  }
}

/** Joins with an external commit; resync replaces this device's old leaf. */
async function join(channelId: string, device: Device, resync: boolean) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const group = await apiFetch<MLSGroup>(groupAPI(channelId));
    const gi = unwire(unb64(group.group_info));
    if (gi.wireformat !== 'mls_group_info') throw new Error('not a GroupInfo');
    const kp = await keyPackage(device);
    const out = await mls.joinGroupExternal(
      gi.groupInfo,
      kp.publicPackage,
      kp.privatePackage,
      resync,
      await impl(),
      undefined,
      config,
    );
    const commit = wire({
      publicMessage: out.publicMessage,
      wireformat: 'mls_public_message',
      version: 'mls10',
    });
    if (
      await postCommit(channelId, device, BigInt(group.epoch), commit, out.newState, {
        joined: true,
      })
    ) {
      const joined = out.newState.groupContext.epoch;
      await save(channelId, out.newState, joined);
      return { state: out.newState, joined };
    }
  }
  throw new Error('could not join the group');
}

/** The leaf of a device in a group, if it is there. */
function leafOf(state: mls.ClientState, deviceId: string): number | undefined {
  for (let i = 0; i < state.ratchetTree.length; i += 2) {
    const node = state.ratchetTree[i];
    if (node?.nodeType !== 'leaf' || node.leaf.credential.credentialType !== 'basic') continue;
    const who = parseIdentity(node.leaf.credential.identity);
    if (who?.deviceId === deviceId) return i / 2;
  }
  return undefined;
}

/**
 * Brings this device's state of a channel's group up to date: joins when it
 * has none, applies the commits it missed, removes stale devices.
 */
export function sync(channelId: string, userId: string): Promise<mls.ClientState> {
  return exclusive(channelId, () => syncLocked(channelId, userId));
}

async function syncLocked(
  channelId: string,
  userId: string,
  retried = false,
): Promise<mls.ClientState> {
  let device: Device;
  try {
    device = await ensureDevice(userId);
    return await syncWith(channelId, device);
  } catch (err) {
    if (!retried && isUnknownDevice(err)) {
      // Removed from another device: register again, rejoin everywhere.
      await forgetDevice(userId);
      await del('groups', channelId);
      return syncLocked(channelId, userId, true);
    }
    throw err;
  }
}

async function syncWith(channelId: string, device: Device): Promise<mls.ClientState> {
  const cs = await impl();
  for (let round = 0; round < 5; round++) {
    const group = await apiFetch<MLSGroup>(groupAPI(channelId));
    const member = group.members.some((m) => m.device_id === device.id);
    let local = await load(channelId);
    if (!local || !member) {
      // Resync replaces this device's own leaf: only while it is still in the group.
      local = await join(channelId, device, member);
      continue;
    }
    let { state } = local;
    // Commits this device missed, in order.
    let broken = false;
    while (state.groupContext.epoch < BigInt(group.epoch) && !broken) {
      const page = await apiFetch<{ commits: MLSCommit[] }>(
        `${groupAPI(channelId)}/commits?from_epoch=${state.groupContext.epoch}`,
      );
      if (!page.commits.length) break;
      for (const c of page.commits) {
        if (BigInt(c.epoch) !== state.groupContext.epoch) continue;
        try {
          const msg = unwire(unb64(c.data));
          if (msg.wireformat !== 'mls_public_message' && msg.wireformat !== 'mls_private_message') {
            throw new Error('not a commit');
          }
          const res = await mls.processMessage(msg, state, mls.emptyPskIndex, mls.acceptAll, cs);
          state = res.newState;
        } catch {
          // A commit this device cannot follow (its own lost one, a gap): rejoin.
          broken = true;
          break;
        }
      }
    }
    if (broken || state.groupContext.epoch < BigInt(group.epoch)) {
      await join(channelId, device, true);
      continue;
    }
    await save(channelId, state, local.joined);
    // Stale devices leave with this device's commit.
    const stale = group.members
      .filter((m) => m.stale && m.device_id !== device.id)
      .map((m) => ({ id: m.device_id, leaf: leafOf(state, m.device_id) }))
      .filter((m): m is { id: string; leaf: number } => m.leaf !== undefined);
    if (stale.length) {
      const res = await mls.createCommit(
        { state, cipherSuite: cs },
        {
          extraProposals: stale.map((m) => ({
            proposalType: 'remove',
            remove: { removed: m.leaf },
          })),
          ratchetTreeExtension: true,
        },
      );
      const ok = await postCommit(
        channelId,
        device,
        state.groupContext.epoch,
        wire(res.commit),
        res.newState,
        {
          removed: stale.map((m) => m.id),
        },
      );
      if (!ok) continue; // someone else changed the group first
      state = res.newState;
      await save(channelId, state, local.joined);
    }
    fresh.add(channelId);
    return state;
  }
  throw new Error('the group keeps changing; try again');
}

// --- messages -----------------------------------------------------------------------------

/** What travels inside an MLS message. */
export interface Payload {
  v: 1;
  /** The Markdown text. */
  t: string;
  /** Files encrypted in the browser (their keys). */
  f?: FileKey[];
  /** The sender's user id: inside the encryption, so the server cannot
   * show one person's message as another's. */
  a?: string;
}

export interface FileKey {
  id: string;
  /** AES-256-GCM key and IV (base64). */
  k: string;
  iv: string;
  name: string;
  type: string;
  size: number;
}

/** Texts opened on this page, by envelope (synchronous previews: notifications). */
const opened = new Map<string, Payload>();

export const openedPayload = (envelope: string) => opened.get(envelope);

async function remember(channelId: string, envelope: string, payload: Payload) {
  opened.set(envelope, payload);
  const key = b64(await sha256(envelope));
  await put('plain', key, { channelId, payload });
  backupHook?.(channelId, key, payload);
}

/** Called for every text this device opened or sealed (history backups). */
let backupHook: ((channelId: string, key: string, payload: Payload) => void) | null = null;
export const onRemember = (fn: typeof backupHook) => {
  backupHook = fn;
};

/** Stores texts from a history backup (keys are envelope hashes). */
export async function restore(channelId: string, items: { h: string; p: Payload }[]) {
  for (const it of items) {
    if (!(await get('plain', it.h))) await put('plain', it.h, { channelId, payload: it.p });
  }
}

/** Seals a payload for a channel's group. */
export async function seal(channelId: string, userId: string, plain: Payload): Promise<string> {
  const payload: Payload = { ...plain, a: userId };
  const envelope = await exclusive(channelId, async () => {
    let state = fresh.has(channelId) ? (await load(channelId))?.state : undefined;
    state ??= await syncLocked(channelId, userId);
    const local = (await load(channelId))!;
    const res = await mls.createApplicationMessage(
      state,
      enc.encode(JSON.stringify(payload)),
      await impl(),
    );
    await save(channelId, res.newState, local.joined);
    return (
      PREFIX +
      b64(
        wire({
          privateMessage: res.privateMessage,
          wireformat: 'mls_private_message',
          version: 'mls10',
        }),
      )
    );
  });
  await remember(channelId, envelope, payload);
  return envelope;
}

const isEpochConflict = (err: unknown) =>
  (err as { problem?: { code?: string } } | null)?.problem?.code === 'epoch_conflict';

/**
 * Seals a payload and sends it with post; when the group moved on meanwhile
 * (the server takes envelopes of the current epoch only), it updates the
 * group and seals again.
 */
export async function send<T>(
  channelId: string,
  userId: string,
  payload: Payload,
  post: (envelope: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const envelope = await seal(channelId, userId, payload);
    try {
      return await post(envelope);
    } catch (err) {
      if (!isEpochConflict(err) || attempt >= 3) throw err;
      fresh.delete(channelId);
    }
  }
}

export type Opened = { payload: Payload } | { unavailable: 'before' | 'broken' };

/** The message an envelope came in, as the server says. */
export interface Claimed {
  id: string;
  author: string;
}

/**
 * What the server says about a message must match what is inside: its author
 * the sender's, and the envelope not one already seen in another message (a
 * replay). Messages from before 0.41 carry no author.
 */
async function vouch(key: string, payload: Payload, claimed?: Claimed): Promise<Opened> {
  if (!claimed) return { payload };
  if (payload.a && payload.a !== claimed.author) return { unavailable: 'broken' };
  const rec = await get<{ channelId: string; payload: Payload; m?: string }>('plain', key);
  if (rec?.m && rec.m !== claimed.id) return { unavailable: 'broken' };
  if (rec && !rec.m) await put('plain', key, { ...rec, m: claimed.id });
  return { payload };
}

/** Opens an envelope of a channel: from this device's texts, or by decrypting it once. */
export async function open(
  channelId: string,
  userId: string,
  envelope: string,
  claimed?: Claimed,
): Promise<Opened> {
  const key = b64(await sha256(envelope));
  const known = opened.get(envelope);
  if (known) return vouch(key, known, claimed);
  const stored = await get<{ payload: Payload }>('plain', key);
  if (stored) {
    opened.set(envelope, stored.payload);
    return vouch(key, stored.payload, claimed);
  }
  let msg: mls.MLSMessage;
  try {
    msg = unwire(unb64(envelope.slice(PREFIX.length)));
  } catch {
    return { unavailable: 'broken' };
  }
  if (msg.wireformat !== 'mls_private_message') return { unavailable: 'broken' };
  const pm = msg.privateMessage;
  return exclusive(channelId, async () => {
    // Another tab may have opened it meanwhile.
    const again = await get<{ payload: Payload }>('plain', key);
    if (again) return vouch(key, again.payload, claimed);
    let local = await load(channelId);
    if (!local || pm.epoch > local.state.groupContext.epoch) {
      await syncLocked(channelId, userId);
      local = await load(channelId);
    }
    if (!local || pm.epoch < local.joined) return { unavailable: 'before' as const };
    try {
      const res = await mls.processPrivateMessage(local.state, pm, mls.emptyPskIndex, await impl());
      await save(channelId, res.newState, local.joined);
      if (res.kind !== 'applicationMessage') return { unavailable: 'broken' as const };
      const payload = JSON.parse(dec.decode(res.message)) as Payload;
      if (payload?.v !== 1 || typeof payload.t !== 'string')
        return { unavailable: 'broken' as const };
      await remember(channelId, envelope, payload);
      return await vouch(key, payload, claimed);
    } catch {
      return { unavailable: 'broken' as const };
    }
  });
}
