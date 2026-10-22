// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkPassword } from '../src/accounts/signin.ts';
import { UserStore } from '../src/accounts/users.ts';
import { ldapConfigSchema, PRESETS, type LdapConfig } from '../src/directory/ldap.ts';
import { SourceStore } from '../src/directory/store.ts';
import { syncSource } from '../src/directory/sync.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

/**
 * Against the development OpenLDAP (deploy/compose/ldap, seed.ldif):
 * IDP_TEST_LDAP_URL (ldap://127.0.0.1:13389) and IDP_TEST_LDAP_PASSWORD.
 */
const LDAP_URL = process.env.IDP_TEST_LDAP_URL;
const LDAP_PASSWORD = process.env.IDP_TEST_LDAP_PASSWORD ?? '';

const config = (over: Partial<LdapConfig> = {}): LdapConfig =>
  ldapConfigSchema.parse({
    ...PRESETS.openldap,
    urls: [LDAP_URL],
    bindDn: 'cn=admin,dc=cenacle,dc=test',
    baseDn: 'ou=people,dc=cenacle,dc=test',
    userFilter: '(&(objectClass=inetOrgPerson)(!(description=disabled)))',
    groupBaseDn: 'ou=groups,dc=cenacle,dc=test',
    adminFilter: '(title=Platform Lead)',
    guestFilter: '(uid=erin)',
    ...over,
  });

describe.skipIf(!hasTestDatabase || !LDAP_URL)('directory (LDAP)', () => {
  let pool: pg.Pool;
  let users: UserStore;
  let sources: SourceStore;

  beforeAll(async () => {
    pool = await openTestDatabase();
    users = new UserStore(pool);
    sources = new SourceStore(pool, randomBytes(32));
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  it('keeps the bind password encrypted', async () => {
    const s = await sources.create({
      name: 'Test',
      config: config(),
      secret: LDAP_PASSWORD,
      syncIntervalMinutes: 60,
    });
    const { rows } = await pool.query('SELECT secret_enc FROM identity_sources WHERE id = $1', [
      s.id,
    ]);
    expect(rows[0].secret_enc.includes(Buffer.from(LDAP_PASSWORD))).toBe(false);
    expect(await sources.secret(s.id)).toBe(LDAP_PASSWORD);
  });

  it('synchronizes people, nested groups, roles and photos, and deactivates leavers', async () => {
    const s = await sources.create({
      name: 'Test',
      config: config(),
      secret: LDAP_PASSWORD,
      syncIntervalMinutes: 60,
    });
    const counts = await syncSource(pool, sources, s, 'manual');
    expect(counts).toMatchObject({ usersSeen: 4, usersCreated: 4, usersDeactivated: 0, groups: 5 });

    const { rows } = await pool.query(
      `SELECT username, display_name, email, title, directory_role, password_hash,
        (SELECT array_agg(g.name ORDER BY g.name) FROM user_groups ug JOIN directory_groups g ON g.id = ug.group_id WHERE ug.user_id = u.id) AS groups,
        (SELECT origin FROM user_photos p WHERE p.user_id = u.id) AS photo
       FROM users u ORDER BY username`,
    );
    const alice = rows.find((r) => r.username === 'alice');
    expect(alice).toMatchObject({
      display_name: 'Alice Admin',
      email: 'alice@cenacle.test',
      title: 'Platform Lead',
      directory_role: 'admin',
      password_hash: null,
      photo: 'directory',
    });
    expect(alice.groups).toEqual(['cenacle-admins', 'engineering', 'staff']);
    const erin = rows.find((r) => r.username === 'erin');
    expect(erin).toMatchObject({ email: null, directory_role: 'guest' });
    expect(erin.groups).toEqual(['contractors']);
    expect(rows.find((r) => r.username === 'dave')).toBeUndefined();

    // Nothing changed: nothing is reported as updated.
    expect(await syncSource(pool, sources, s, 'manual')).toMatchObject({
      usersCreated: 0,
      usersUpdated: 0,
    });

    // Bob leaves (the filter no longer admits him): deactivated, sessions gone.
    const bob = rows.find((r) => r.username === 'bob');
    void bob;
    await sources.update(s.id, {
      name: 'Test',
      enabled: true,
      syncIntervalMinutes: 60,
      config: config({
        userFilter: '(&(objectClass=inetOrgPerson)(!(description=disabled))(!(uid=bob)))',
      }),
    });
    const after = await syncSource(pool, sources, (await sources.get(s.id))!, 'schedule');
    expect(after.usersDeactivated).toBe(1);
    const { rows: disabled } = await pool.query(
      `SELECT username FROM users WHERE disabled_at IS NOT NULL`,
    );
    expect(disabled.map((r) => r.username)).toEqual(['bob']);
    const runs = await sources.runs(s.id);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({
      status: 'succeeded',
      trigger: 'schedule',
      usersDeactivated: 1,
    });
  });

  it('a directory that returns nobody changes nothing', async () => {
    const s = await sources.create({
      name: 'Test',
      config: config(),
      secret: LDAP_PASSWORD,
      syncIntervalMinutes: 60,
    });
    await syncSource(pool, sources, s, 'manual');
    await sources.update(s.id, {
      name: 'Test',
      enabled: true,
      syncIntervalMinutes: 60,
      config: config({ userFilter: '(uid=nobody-at-all)' }),
    });
    await expect(syncSource(pool, sources, (await sources.get(s.id))!, 'manual')).rejects.toThrow(
      /no people/,
    );
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM users WHERE disabled_at IS NULL',
    );
    expect(rows[0].n).toBe(4);
    expect((await sources.runs(s.id))[0]).toMatchObject({ status: 'failed' });
  });

  it('signs people in with their directory password, by username or e-mail', async () => {
    await sources.create({
      name: 'Test',
      config: config(),
      secret: LDAP_PASSWORD,
      syncIntervalMinutes: 60,
    });
    const directory = { pool, sources };
    const ok = await checkPassword(users, directory, 'carol', 'carol-dev-password');
    expect('user' in ok && ok.user.displayName).toBe('Carol Designer');
    expect(await users.groups((ok as { user: { id: string } }).user.id)).toEqual([
      'design',
      'staff',
    ]);
    expect(await checkPassword(users, directory, 'carol', 'wrong')).toEqual({ error: 'invalid' });
    expect(await checkPassword(users, directory, 'carol', '')).toEqual({ error: 'invalid' });
    // Disabled in the directory (outside the user filter): no sign-in.
    expect(await checkPassword(users, directory, 'dave', 'dave-dev-password')).toEqual({
      error: 'invalid',
    });
    // Filter syntax in the name is just text.
    expect(await checkPassword(users, directory, '*', 'carol-dev-password')).toEqual({
      error: 'invalid',
    });
    // By e-mail address (login attribute mail).
    await pool.query('TRUNCATE identity_sources CASCADE');
    await sources.create({
      name: 'Mail',
      config: config({ loginAttribute: 'mail' }),
      secret: LDAP_PASSWORD,
      syncIntervalMinutes: 60,
    });
    const byMail = await checkPassword(users, directory, 'bob@cenacle.test', 'bob-dev-password');
    expect('user' in byMail).toBe(true);
  });

  it('an unreachable directory is reported, not treated as a wrong password', async () => {
    await sources.create({
      name: 'Down',
      config: config({ urls: ['ldap://127.0.0.1:1'], timeoutMs: 1000 }),
      secret: '',
      syncIntervalMinutes: 60,
    });
    expect(await checkPassword(users, { pool, sources }, 'carol', 'carol-dev-password')).toEqual({
      error: 'unavailable',
    });
  });

  it('links an existing local account with the same address', async () => {
    const local = await users.create({
      email: 'bob@cenacle.test',
      displayName: 'Bob',
      password: 'a long local password here',
    });
    const s = await sources.create({
      name: 'Test',
      config: config(),
      secret: LDAP_PASSWORD,
      syncIntervalMinutes: 60,
    });
    await syncSource(pool, sources, s, 'manual');
    const linked = await users.findById(local.id);
    expect(linked).toMatchObject({
      displayName: 'Bob Engineer',
      fromDirectory: true,
      username: 'bob',
    });
    // The local password no longer works; the directory's does.
    expect(await users.authenticate('bob@cenacle.test', 'a long local password here')).toBeNull();
  });
});
