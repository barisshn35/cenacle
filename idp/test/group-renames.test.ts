// SPDX-License-Identifier: AGPL-3.0-only
// Changes of the names apps see for groups (ADR 0046): recorded when 0.99.2's
// naming rule came in (migration 0011) and when a provider is renamed, read by
// the directory feed's clients.
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { registerDirectoryFeed } from '../src/directory/feed.ts';
import type { OidcConfig } from '../src/federation/config.ts';
import { ProviderStore } from '../src/federation/store.ts';
import type { ClientMetadata } from '../src/oidc/clients.ts';
import {
  hasTestDatabase,
  openTestDatabase,
  resetTestDatabase,
  TEST_DATABASE_URL,
} from './helpers/db.ts';

const chat = {
  client_id: 'chat',
  client_secret: 'feed-secret-0123456789',
  redirect_uris: ['https://chat.example.com/cb'],
  cenacle_directory: true,
} as ClientMetadata;
const other = { ...chat, client_id: 'other', cenacle_directory: false } as ClientMetadata;
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

interface Change {
  old_name: string;
  new_name: string;
  ambiguous: boolean;
}

describe.skipIf(!hasTestDatabase)('group renames (database)', () => {
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

  const source = async (kind: string, name: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO identity_sources (kind, name, config) VALUES ($1, $2, '{}') RETURNING id`,
        [kind, name],
      )
    ).rows[0]!.id;
  const group = (sourceId: string, name: string) =>
    pool.query(`INSERT INTO directory_groups (source_id, external_id, name) VALUES ($1, $2, $2)`, [
      sourceId,
      name,
    ]);
  const changes = async () =>
    (
      await pool.query<Change>(
        'SELECT old_name, new_name, ambiguous FROM group_name_changes ORDER BY id',
      )
    ).rows;

  /** Rolls back the migrations from `name` (included) to the latest. */
  const downTo = async (name: string) => {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM idp_migrations ORDER BY id DESC',
    );
    const count = rows.findIndex((r) => r.name === name) + 1;
    await migrate({ databaseUrl: TEST_DATABASE_URL!, direction: 'down', count });
  };

  it('records the 0.99.2 names of provider groups, never over a directory group', async () => {
    // The groups as a 0.99.1 installation has them, before migration 0011.
    await downTo('0011_group_name_changes');
    try {
      const corp = await source('ldap', 'Corp');
      const acme = await source('oidc', 'Ac/me');
      const partner = await source('saml', 'Partner');
      await group(corp, 'Staff');
      await group(acme, 'staff'); // a directory's group: the bare name stays its
      await group(acme, 'Design'); // only Acme has it
      await group(acme, 'Ops'); // Acme and Partner: ambiguous
      await group(partner, 'OPS');
      await group(partner, 'x'.repeat(195)); // too long with the prefix: never sent
      await pool.query(
        `INSERT INTO users (source_id, external_id, display_name, updated_at)
         VALUES ($1, 'eve', 'Eve', now() - interval '1 day')`,
        [acme],
      );
      await pool.query(
        `INSERT INTO user_groups (user_id, group_id)
         SELECT u.id, g.id FROM users u, directory_groups g WHERE g.name = 'Design'`,
      );
    } finally {
      await migrate({ databaseUrl: TEST_DATABASE_URL!, direction: 'up' });
    }
    expect(await changes()).toEqual([
      { old_name: 'Design', new_name: 'Ac-me/Design', ambiguous: false },
      { old_name: 'OPS', new_name: 'Partner/OPS', ambiguous: true },
      { old_name: 'Ops', new_name: 'Ac-me/Ops', ambiguous: true },
    ]);
    // Their people are sent again, after the changes.
    const { rows } = await pool.query(
      `SELECT 1 FROM users WHERE updated_at > now() - interval '1 minute'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('records the new names when a provider is renamed', async () => {
    const providers = new ProviderStore(pool, randomBytes(32));
    const id = await source('oidc', 'Acme');
    await group(id, 'Design');
    await group(id, 'Leads');
    // A directory's group with the provider's old name for Leads.
    await group(await source('ldap', 'Corp'), 'acme/leads');
    const rename = (name: string) =>
      providers.update(id, { name, config: {} as OidcConfig, enabled: true });

    await rename('Acme');
    expect(await changes()).toEqual([]);
    await rename('Acme/Corp');
    expect(await changes()).toEqual([
      { old_name: 'Acme/Design', new_name: 'Acme-Corp/Design', ambiguous: false },
      // The old name met the directory's group: the chat leaves it to people.
      { old_name: 'Acme/Leads', new_name: 'Acme-Corp/Leads', ambiguous: true },
    ]);
    // "/" and "-" give the same name: nothing changes for apps.
    await rename('Acme-Corp');
    expect(await changes()).toHaveLength(2);
  });

  it('never lets two providers give their groups the same prefix', async () => {
    // Saved before the rule held: "Corp/EU" next to "Corp-EU" (both "Corp-EU/").
    await downTo('0012_provider_prefix_unique');
    let second = '';
    try {
      await group(await source('oidc', 'Corp-EU'), 'Staff');
      second = await source('saml', 'corp/eu');
      await group(second, 'Staff');
    } finally {
      await migrate({ databaseUrl: TEST_DATABASE_URL!, direction: 'up' });
    }
    // The newer one is renamed; mappings of its old names need a person.
    const renamed = `corp/eu (${second.slice(0, 8)})`;
    const { rows } = await pool.query('SELECT name FROM identity_sources WHERE id = $1', [second]);
    expect(rows).toEqual([{ name: renamed }]);
    expect(await changes()).toEqual([
      {
        old_name: 'corp-eu/Staff',
        new_name: `corp-eu (${second.slice(0, 8)})/Staff`,
        ambiguous: true,
      },
    ]);

    const providers = new ProviderStore(pool, randomBytes(32));
    expect(await providers.nameTaken('CORP/eu')).toBe(true);
    expect(await providers.nameTaken('Corp-EU', second)).toBe(true);
    expect(await providers.nameTaken(renamed, second)).toBe(false);
    expect(await providers.nameTaken('Corp EU')).toBe(false);
    await expect(source('oidc', 'Corp/EU')).rejects.toThrow(/identity_sources_group_prefix/);
  });

  it('serves the changes in order to the feed’s clients only', async () => {
    for (const auth of [undefined, basic('other', chat.client_secret), basic('chat', 'wrong')]) {
      const res = await app.inject({
        url: '/directory/v1/group-renames',
        headers: auth ? { authorization: auth } : {},
      });
      expect(res.statusCode).toBe(401);
    }
    await pool.query(
      `INSERT INTO group_name_changes (old_name, new_name, ambiguous, created_at)
       SELECT 'g' || i, 'P/g' || i, false, now() - interval '1 minute' FROM generate_series(1, 501) i ORDER BY i`,
    );
    // Not served yet: a change still committing could land behind the cursor.
    await pool.query(`INSERT INTO group_name_changes (old_name, new_name) VALUES ('new', 'P/new')`);
    const headers = { authorization: basic('chat', chat.client_secret) };
    const first = (await app.inject({ url: '/directory/v1/group-renames', headers })).json();
    expect(first.renames).toHaveLength(500);
    expect(first.renames[0]).toEqual({
      id: expect.any(String),
      old: 'g1',
      new: 'P/g1',
      ambiguous: false,
    });
    expect(first.more).toBe(true);
    const second = (
      await app.inject({ url: `/directory/v1/group-renames?after=${first.next}`, headers })
    ).json();
    expect(second.renames.map((r: { old: string }) => r.old)).toEqual(['g501']);
    expect(second.more).toBe(false);
    const third = (
      await app.inject({ url: `/directory/v1/group-renames?after=${second.next}`, headers })
    ).json();
    expect(third).toEqual({ renames: [], next: second.next, more: false });
    // A malformed cursor reads from the start.
    const bad = (await app.inject({ url: '/directory/v1/group-renames?after=x', headers })).json();
    expect(bad.renames).toHaveLength(500);
  });
});
