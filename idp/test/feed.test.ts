// SPDX-License-Identifier: AGPL-3.0-only
// The directory feed apps read changed accounts from.
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserStore } from '../src/accounts/users.ts';
import { registerDirectoryFeed } from '../src/directory/feed.ts';
import type { ClientMetadata } from '../src/oidc/clients.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

const chat = {
  client_id: 'chat',
  client_secret: 'feed-secret-0123456789',
  redirect_uris: ['https://chat.example.com/cb'],
  cenacle_directory: true,
} as ClientMetadata;
const other = { ...chat, client_id: 'other', cenacle_directory: false } as ClientMetadata;
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

describe.skipIf(!hasTestDatabase)('directory feed (database)', () => {
  let pool: pg.Pool;
  const app = Fastify();

  beforeAll(async () => {
    pool = await openTestDatabase();
    registerDirectoryFeed(app, { pool, clients: [chat, other] });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  it('answers only clients registered for it', async () => {
    for (const auth of [undefined, basic('other', chat.client_secret), basic('chat', 'wrong')]) {
      const res = await app.inject({
        url: '/directory/v1/changes',
        headers: auth ? { authorization: auth } : {},
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('lists changed people with their photo, which it serves', async () => {
    const u = await new UserStore(pool).create({
      email: 'ada@example.com',
      displayName: 'Ada',
      password: 'correct horse battery staple',
    });
    const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await pool.query(
      `INSERT INTO user_photos (user_id, origin, content_type, data) VALUES ($1, 'directory', 'image/png', $2)`,
      [u.id, photo],
    );
    // Changes of the last two seconds wait for the next call.
    await pool.query(`UPDATE users SET updated_at = now() - interval '1 minute'`);
    const headers = { authorization: basic('chat', chat.client_secret) };
    const res = await app.inject({ url: '/directory/v1/changes', headers });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.users).toEqual([
      expect.objectContaining({
        sub: u.id,
        name: 'Ada',
        picture: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    // Read from the cursor on: nothing new.
    const next = await app.inject({
      url: `/directory/v1/changes?after=${encodeURIComponent(page.next)}`,
      headers,
    });
    expect(next.json().users).toEqual([]);

    const img = await app.inject({ url: `/directory/v1/photos/${u.id}`, headers });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(photo)).toBe(true);
    expect((await app.inject({ url: `/directory/v1/photos/${u.id}` })).statusCode).toBe(401);
  });
});
