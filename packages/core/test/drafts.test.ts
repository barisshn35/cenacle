// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CenacleDatabase, DraftStore } from '../src/drafts';

let db: CenacleDatabase;
let clock: number;
let store: DraftStore;

beforeEach(() => {
  db = new CenacleDatabase(`test-${crypto.randomUUID()}`);
  clock = 1_000;
  store = new DraftStore(db, () => clock);
});

afterEach(async () => {
  await db.delete();
});

const a = { workspaceId: 'w1', channelId: 'c1' };
const b = { workspaceId: 'w1', channelId: 'c2' };
const c = { workspaceId: 'w2', channelId: 'c1' };

describe('DraftStore', () => {
  it('saves and reads a draft per channel', async () => {
    await store.save(a, 'hello');
    await store.save(c, 'other workspace');
    expect(await store.get(a)).toEqual({ ...a, body: 'hello', updatedAt: 1_000 });
    expect((await store.get(c))?.body).toBe('other workspace');
    expect(await store.get(b)).toBeUndefined();
  });

  it('overwrites and updates the timestamp', async () => {
    await store.save(a, 'v1');
    clock = 2_000;
    await store.save(a, 'v2');
    expect(await store.get(a)).toMatchObject({ body: 'v2', updatedAt: 2_000 });
  });

  it('deletes the draft when the body becomes empty', async () => {
    await store.save(a, 'text');
    expect(await store.save(a, '   \n')).toBeUndefined();
    expect(await store.get(a)).toBeUndefined();
  });

  it('lists drafts newest first, optionally per workspace', async () => {
    await store.save(a, 'a');
    clock = 3_000;
    await store.save(b, 'b');
    clock = 2_000;
    await store.save(c, 'c');
    expect((await store.list()).map((d) => d.body)).toEqual(['b', 'c', 'a']);
    expect((await store.list('w1')).map((d) => d.body)).toEqual(['b', 'a']);
  });

  it('prunes old drafts', async () => {
    await store.save(a, 'old');
    clock = 100_000;
    await store.save(b, 'new');
    expect(await store.prune(50_000)).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it('survives a new connection (reload)', async () => {
    await store.save(a, 'persisted');
    db.close();
    const reopened = new CenacleDatabase(db.name);
    expect((await new DraftStore(reopened).get(a))?.body).toBe('persisted');
    reopened.close();
    await db.open();
  });
});
