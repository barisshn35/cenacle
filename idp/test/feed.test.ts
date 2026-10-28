// SPDX-License-Identifier: AGPL-3.0-only
// The directory feed apps read changed accounts from.
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserStore } from '../src/accounts/users.ts';
import { registerDirectoryFeed } from '../src/directory/feed.ts';
import type { OidcConfig } from '../src/federation/config.ts';
import { ProviderStore } from '../src/federation/store.ts';
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
    for (const auth of [
      undefined,
      basic('other', chat.client_secret),
      basic('chat', 'wrong'),
      // Malformed form-encoding answers 401, not 500.
      basic('chat', '%E0%A4%A'),
      basic('%', chat.client_secret),
    ]) {
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

  it('names an identity provider’s groups after it, never like a directory’s', async () => {
    const source = async (kind: string, name: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO identity_sources (kind, name, config) VALUES ($1, $2, '{}') RETURNING id`,
          [kind, name],
        )
      ).rows[0]!.id;
    const member = async (sourceId: string, externalId: string, group: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (source_id, external_id, display_name) VALUES ($1, $2, $2) RETURNING id`,
        [sourceId, externalId],
      );
      await pool.query(
        `WITH g AS (INSERT INTO directory_groups (source_id, external_id, name) VALUES ($1, $2, $2)
                    ON CONFLICT (source_id, external_id) DO UPDATE SET name = EXCLUDED.name RETURNING id)
         INSERT INTO user_groups (user_id, group_id) SELECT $3, id FROM g`,
        [sourceId, group, rows[0]!.id],
      );
      return rows[0]!.id;
    };
    const corp = await member(await source('ldap', 'Corp'), 'ada', 'Engineering Leads');
    const partner = await member(await source('oidc', 'Part/ner'), 'eve', 'Engineering Leads');
    const long = await member(await source('saml', 'Long'), 'bob', 'x'.repeat(200));
    const users = new UserStore(pool);
    expect(await users.groups(corp)).toEqual(['Engineering Leads']);
    expect(await users.groups(partner)).toEqual(['Part-ner/Engineering Leads']);
    // More than an app keeps: left out rather than cut to a name it could share.
    expect(await users.groups(long)).toEqual([]);

    await pool.query(`UPDATE users SET updated_at = now() - interval '1 minute'`);
    const res = await app.inject({
      url: '/directory/v1/changes',
      headers: { authorization: basic('chat', chat.client_secret) },
    });
    const groups = Object.fromEntries(
      res.json().users.map((u: { sub: string; groups: string[] }) => [u.sub, u.groups]),
    );
    expect(groups).toEqual({
      [corp]: ['Engineering Leads'],
      [partner]: ['Part-ner/Engineering Leads'],
      [long]: [],
    });

    // Renaming the provider renames its groups; the feed reports its people again.
    const partnerSource = (
      await pool.query<{ source_id: string }>('SELECT source_id FROM users WHERE id = $1', [
        partner,
      ])
    ).rows[0]!.source_id;
    await new ProviderStore(pool, randomBytes(32)).update(partnerSource, {
      name: 'Partner',
      config: {} as OidcConfig,
      enabled: true,
    });
    expect(await users.groups(partner)).toEqual(['Partner/Engineering Leads']);
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE updated_at > now() - interval '10 seconds'`,
    );
    expect(rows).toEqual([{ id: partner }]);
  });
});
