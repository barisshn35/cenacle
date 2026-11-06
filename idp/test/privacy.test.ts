// SPDX-License-Identifier: AGPL-3.0-only
// A person's data as one file, and deleting an account (admin panel, CLI).
import { randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/accounts/audit.ts';
import { MfaStore } from '../src/accounts/mfa.ts';
import { exportAccount, type ExportItem } from '../src/accounts/privacy.ts';
import { UserStore } from '../src/accounts/users.ts';
import { registerAccount } from '../src/account/routes.ts';
import { ACCOUNT_COOKIE, signAccount } from '../src/account/session.ts';
import { registerAdmin } from '../src/admin/routes.ts';
import { main } from '../src/cli.ts';
import { registerDirectoryFeed } from '../src/directory/feed.ts';
import { ldapConfigSchema, PRESETS } from '../src/directory/ldap.ts';
import { SourceStore } from '../src/directory/store.ts';
import type { ClientMetadata } from '../src/oidc/clients.ts';
import {
  hasTestDatabase,
  openTestDatabase,
  resetTestDatabase,
  TEST_DATABASE_URL,
} from './helpers/db.ts';

const ISSUER = 'https://id.example.com';
const KEYS = ['a-cookie-key-for-the-tests-only'];
const PASSWORD = 'correct horse battery staple';
const chat = {
  client_id: 'chat',
  client_secret: 'feed-secret-0123456789',
  redirect_uris: ['https://chat.example.com/cb'],
  cenacle_directory: true,
} as ClientMetadata;
const feedAuth = {
  authorization: `Basic ${Buffer.from(`chat:${chat.client_secret}`).toString('base64')}`,
};
const post = (id: string) => ({
  cookie: `${ACCOUNT_COOKIE}=${signAccount(KEYS, id)}`,
  'sec-fetch-site': 'same-origin',
  origin: ISSUER,
  'content-type': 'application/x-www-form-urlencoded',
});
// A directory as the admin panel saves it, turned off: the test database is
// shared with the full-stack tests, whose Cenacle ID lists its directories.
const CORP = JSON.stringify(
  ldapConfigSchema.parse({
    ...PRESETS.openldap,
    urls: ['ldaps://dc1.example.com'],
    baseDn: 'dc=example,dc=com',
  }),
);

const lines = (body: string) =>
  body
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ExportItem);

describe.skipIf(!hasTestDatabase)('data export and account deletion (database)', () => {
  let pool: pg.Pool;
  let users: UserStore;
  const a = Fastify();

  beforeAll(async () => {
    pool = await openTestDatabase();
    users = new UserStore(pool);
    const kek = randomBytes(32);
    a.decorateRequest(
      'cookieValue',
      function (this: { headers: { cookie?: string } }, name: string) {
        const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(this.headers.cookie ?? '');
        return m?.[1];
      },
    );
    await a.register(formbody);
    const common = {
      users,
      mfa: new MfaStore(pool, kek),
      audit: new AuditLog(pool),
      issuer: ISSUER,
      cookieKeys: KEYS,
      formActionOrigins: [],
    };
    await registerAccount(a, { ...common, pool });
    await registerAdmin(a, { ...common, pool, sources: new SourceStore(pool, kek) });
    registerDirectoryFeed(a, { pool, clients: [chat] });
    await a.ready();
  });
  afterAll(async () => {
    await a.close();
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  /** A person with something of everything Cenacle ID keeps. */
  async function person(email = 'ada@example.com') {
    const u = await users.create({ email, displayName: 'Ada', password: PASSWORD });
    const secret = randomBytes(20);
    await pool.query(
      `UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now() WHERE id = $1`,
      [u.id, secret],
    );
    const codeHash = randomBytes(32);
    await pool.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2), ($1, $3)`, [
      u.id,
      codeHash,
      randomBytes(32),
    ]);
    await pool.query(`UPDATE recovery_codes SET used_at = now() WHERE code_hash = $1`, [codeHash]);
    const publicKey = randomBytes(77);
    await pool.query(
      `INSERT INTO passkeys (id, user_id, public_key, device_type, name)
       VALUES ('credential-id', $1, $2, 'multiDevice', 'Laptop')`,
      [u.id, publicKey],
    );
    const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
    await pool.query(
      `INSERT INTO user_photos (user_id, origin, content_type, data) VALUES ($1, 'upload', 'image/png', $2)`,
      [u.id, photo],
    );
    const { rows: src } = await pool.query<{ id: string }>(
      `INSERT INTO identity_sources (kind, name, config, enabled) VALUES ('ldap', 'Corp', $1, false)
       RETURNING id`,
      [CORP],
    );
    await pool.query(
      `WITH g AS (INSERT INTO directory_groups (source_id, external_id, name) VALUES ($1, 'eng', 'Engineering') RETURNING id)
       INSERT INTO user_groups (user_id, group_id) SELECT $2, id FROM g`,
      [src[0]!.id, u.id],
    );
    await pool.query(`INSERT INTO signin_attempts (user_id, kind) VALUES ($1, 'password')`, [u.id]);
    await pool.query(
      `INSERT INTO oidc_payloads (model, id, payload, expires_at) VALUES
         ('Session', 's1', $1, now() + interval '1 day'),
         ('Grant', 'g1', $2, now() + interval '1 day'),
         ('AccessToken', 't1', $3, now() + interval '1 hour'),
         ('Interaction', 'i1', $3, now() + interval '1 hour')`,
      [
        JSON.stringify({ accountId: u.id, loginTs: 1_700_000_000 }),
        JSON.stringify({ accountId: u.id, clientId: 'chat', iat: 1_700_000_000 }),
        JSON.stringify({ accountId: u.id, jti: 'a-token-value' }),
      ],
    );
    const audit = new AuditLog(pool);
    await audit.record('account.signed_in', u.id, '203.0.113.7');
    await audit.record('passkey.added', u.id, '203.0.113.7', { name: 'Laptop' });
    await audit.record('signin.failed', u.id, '203.0.113.8', { email, where: 'account' });
    // Someone typing the address for no account: only the address goes.
    await audit.record('signin.failed', null, '198.51.100.1', { email, where: 'account' });
    return { ...u, secret, codeHash, publicKey, photo };
  }

  it('exports the account without its secrets', async () => {
    const p = await person();
    const items = (await exportAccount(pool, p.id))!;
    const kinds = items.map((i) => i.kind);
    expect(new Set(kinds)).toEqual(
      new Set([
        'account',
        'photo',
        'group',
        'passkey',
        'recovery_codes',
        'signin_attempt',
        'session',
        'app_grant',
        'audit',
      ]),
    );
    const account = items.find((i) => i.kind === 'account')!.data;
    expect(account).toMatchObject({
      id: p.id,
      email: 'ada@example.com',
      display_name: 'Ada',
      password_set: true,
      two_step: { enabled: true },
    });
    expect(items.find((i) => i.kind === 'photo')!.data).toMatchObject({
      content_type: 'image/png',
      base64: p.photo.toString('base64'),
    });
    expect(items.find((i) => i.kind === 'group')!.data).toMatchObject({
      name: 'Engineering',
      source: 'Corp',
    });
    expect(items.find((i) => i.kind === 'passkey')!.data).toMatchObject({
      name: 'Laptop',
      device_type: 'multiDevice',
    });
    expect(items.find((i) => i.kind === 'recovery_codes')!.data).toEqual({ unused: 1, used: 1 });
    expect(items.find((i) => i.kind === 'app_grant')!.data).toMatchObject({ client_id: 'chat' });
    const audit = items.filter((i) => i.kind === 'audit').map((i) => i.data);
    expect(audit.map((e) => e.action)).toEqual([
      'account.signed_in',
      'passkey.added',
      'signin.failed',
    ]);
    expect(audit[0]).toMatchObject({ ip: '203.0.113.7' });

    const text = JSON.stringify(items);
    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [p.id],
    );
    for (const secret of [
      rows[0]!.password_hash,
      p.secret.toString('base64'),
      p.secret.toString('hex'),
      p.codeHash.toString('base64'),
      p.codeHash.toString('hex'),
      p.publicKey.toString('base64'),
      p.publicKey.toString('hex'),
      'credential-id',
      'a-token-value',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/password_hash|totp_secret|code_hash|public_key/);
    expect(await exportAccount(pool, '01900000-0000-7000-8000-00000000dead')).toBeNull();
  });

  it('lets a person download their data, and an administrator any account’s', async () => {
    const p = await person();
    const own = await a.inject({ method: 'POST', url: '/account/data', headers: post(p.id) });
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toContain('application/x-ndjson');
    expect(own.headers['content-disposition']).toContain('attachment');
    expect(lines(own.body)[0]).toMatchObject({ kind: 'account', data: { id: p.id } });
    // Another site cannot make the browser download it.
    const cross = await a.inject({
      method: 'POST',
      url: '/account/data',
      headers: { ...post(p.id), 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    });
    expect(cross.statusCode).toBe(403);

    const admin = await users.create({
      email: 'admin@example.com',
      displayName: 'Admin',
      password: PASSWORD,
    });
    await users.setAdminById(admin.id, true);
    // Not an administrator: no other account's data.
    const denied = await a.inject({
      method: 'POST',
      url: `/account/admin/accounts/${admin.id}/export`,
      headers: post(p.id),
    });
    expect(denied.statusCode).toBe(403);
    const byAdmin = await a.inject({
      method: 'POST',
      url: `/account/admin/accounts/${p.id}/export`,
      headers: post(admin.id),
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(lines(byAdmin.body)[0]).toMatchObject({ kind: 'account', data: { id: p.id } });

    const { rows } = await pool.query(
      `SELECT action, user_id, detail FROM audit_events WHERE action LIKE '%data_exported' ORDER BY at, id`,
    );
    expect(rows).toEqual([
      { action: 'account.data_exported', user_id: p.id, detail: {} },
      { action: 'admin.account.data_exported', user_id: admin.id, detail: { account: p.id } },
    ]);
  });

  it('deletes an account after the address is typed, and tells the apps', async () => {
    const p = await person();
    const admin = await users.create({
      email: 'admin@example.com',
      displayName: 'Admin',
      password: PASSWORD,
    });
    await users.setAdminById(admin.id, true);

    const confirmPage = await a.inject({
      url: `/account/admin/accounts/${p.id}/delete`,
      headers: { cookie: post(admin.id).cookie },
    });
    expect(confirmPage.statusCode).toBe(200);
    expect(confirmPage.body).toContain('ada@example.com');
    // A local account comes back from nowhere: no such warning.
    expect(confirmPage.body).not.toContain('data-testid="delete-returns"');

    // Not themselves, and not without the address.
    const self = await a.inject({
      method: 'POST',
      url: `/account/admin/accounts/${admin.id}/delete`,
      headers: post(admin.id),
      payload: 'confirm=admin%40example.com',
    });
    expect(self.headers.location).toBe('/account/admin?error=self');
    const wrong = await a.inject({
      method: 'POST',
      url: `/account/admin/accounts/${p.id}/delete`,
      headers: post(admin.id),
      payload: 'confirm=someone%40example.com',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('aria-invalid="true"');
    expect(await users.findById(p.id)).not.toBeNull();

    // A feed reader that has seen everyone so far.
    await pool.query(`UPDATE users SET updated_at = now() - interval '2 minutes'`);
    const before = (await a.inject({ url: '/directory/v1/changes', headers: feedAuth })).json();
    expect(before.users.map((u: { sub: string }) => u.sub).sort()).toEqual([p.id, admin.id].sort());

    const done = await a.inject({
      method: 'POST',
      url: `/account/admin/accounts/${p.id}/delete`,
      headers: post(admin.id),
      payload: 'confirm=ADA%40example.com',
    });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/account/admin?done=deleted');

    expect(await users.findById(p.id)).toBeNull();
    for (const table of [
      'user_photos',
      'user_groups',
      'passkeys',
      'recovery_codes',
      'signin_attempts',
    ]) {
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [p.id]);
      expect(rows, table).toEqual([]);
    }
    const payloads = await pool.query(
      `SELECT model FROM oidc_payloads WHERE payload->>'accountId' = $1`,
      [p.id],
    );
    expect(payloads.rows).toEqual([]);

    // The events stay, without the account, its addresses and its IPs.
    const { rows: events } = await pool.query(
      `SELECT action, user_id, ip, detail FROM audit_events ORDER BY at, id`,
    );
    expect(events).toEqual([
      { action: 'account.signed_in', user_id: null, ip: '', detail: {} },
      { action: 'passkey.added', user_id: null, ip: '', detail: {} },
      { action: 'signin.failed', user_id: null, ip: '', detail: { where: 'account' } },
      { action: 'signin.failed', user_id: null, ip: '198.51.100.1', detail: { where: 'account' } },
      {
        action: 'admin.account.deleted',
        user_id: admin.id,
        ip: expect.any(String),
        detail: { account: p.id },
      },
    ]);

    // The feed reports it once the tombstone is older than two seconds:
    // disabled, sessions ended, nothing else.
    await pool.query(`UPDATE deleted_accounts SET deleted_at = now() - interval '1 minute'`);
    const after = (
      await a.inject({
        url: `/directory/v1/changes?after=${encodeURIComponent(before.next)}`,
        headers: feedAuth,
      })
    ).json();
    expect(after.users).toEqual([
      {
        sub: p.id,
        name: '',
        email: '',
        email_verified: false,
        preferred_username: '',
        groups: [],
        cenacle_role: '',
        disabled: true,
        sessions_ended_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        picture: '',
      },
    ]);
    const again = (
      await a.inject({
        url: `/directory/v1/changes?after=${encodeURIComponent(after.next)}`,
        headers: feedAuth,
      })
    ).json();
    expect(again.users).toEqual([]);
  });

  it('merges deleted accounts into the order of the changes', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      ids.push(
        (
          await users.create({
            email: `p${n}@example.com`,
            displayName: `P${n}`,
            password: PASSWORD,
          })
        ).id,
      );
    }
    // p1 changed 3 minutes ago, p2 was deleted 2 minutes ago, p3 changed 1 minute ago.
    await pool.query(`UPDATE users SET updated_at = now() - interval '3 minutes' WHERE id = $1`, [
      ids[0],
    ]);
    await pool.query(`UPDATE users SET updated_at = now() - interval '1 minute' WHERE id = $1`, [
      ids[2],
    ]);
    await pool.query('DELETE FROM users WHERE id = $1', [ids[1]]);
    await pool.query(
      `INSERT INTO deleted_accounts (id, deleted_at) VALUES ($1, now() - interval '2 minutes')`,
      [ids[1]],
    );
    const all = (await a.inject({ url: '/directory/v1/changes', headers: feedAuth })).json();
    expect(all.users.map((u: { sub: string; disabled: boolean }) => [u.sub, u.disabled])).toEqual([
      [ids[0], false],
      [ids[1], true],
      [ids[2], false],
    ]);
    // Read one at a time from each cursor: the same order, nothing twice.
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 4; i++) {
      const page = (
        await a.inject({
          url: `/directory/v1/changes${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`,
          headers: feedAuth,
        })
      ).json();
      if (page.users.length === 0) break;
      seen.push(page.users[0].sub);
      // Take only the first of the page, as a reader with a page of one would.
      const first = page.users[0];
      const { rows } = await pool.query<{ at: string }>(
        `SELECT coalesce((SELECT updated_at::text FROM users WHERE id = $1),
                         (SELECT deleted_at::text FROM deleted_accounts WHERE id = $1)) AS at`,
        [first.sub],
      );
      cursor = `${rows[0]!.at}|${first.sub}`;
    }
    expect(seen).toEqual(ids);
  });

  it('exports and deletes from the command line', async () => {
    const p = await person();
    const saved = process.env.IDP_DATABASE_URL;
    process.env.IDP_DATABASE_URL = TEST_DATABASE_URL;
    const out: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => (out.push(String(chunk)), true));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['users', 'export', '--email', 'ada@example.com'])).toBe(0);
      expect(lines(out.join(''))[0]).toMatchObject({ kind: 'account', data: { id: p.id } });
      // Not on a terminal and without --yes: nothing is deleted.
      expect(await main(['users', 'delete', '--email', 'ada@example.com'])).toBe(2);
      expect(await users.findById(p.id)).not.toBeNull();
      expect(await main(['users', 'delete', '--email', 'ada@example.com', '--yes'])).toBe(0);
      expect(await users.findById(p.id)).toBeNull();
      expect(await main(['users', 'delete', '--email', 'ada@example.com', '--yes'])).toBe(2);
    } finally {
      write.mockRestore();
      log.mockRestore();
      error.mockRestore();
      if (saved === undefined) delete process.env.IDP_DATABASE_URL;
      else process.env.IDP_DATABASE_URL = saved;
    }
    const { rows } = await pool.query(
      `SELECT action, detail FROM audit_events WHERE action LIKE 'admin.account.%' ORDER BY at, id`,
    );
    expect(rows).toEqual([
      { action: 'admin.account.data_exported', detail: { account: p.id, via: 'cli' } },
      { action: 'admin.account.deleted', detail: { account: p.id, via: 'cli' } },
    ]);
    const tomb = await pool.query('SELECT id FROM deleted_accounts');
    expect(tomb.rows).toEqual([{ id: p.id }]);
  });
});

describe.skipIf(!hasTestDatabase)('deleting a directory account (database)', () => {
  it('warns that the directory brings the person back', async () => {
    const pool = await openTestDatabase();
    const a = Fastify();
    try {
      await resetTestDatabase(pool);
      const users = new UserStore(pool);
      const kek = randomBytes(32);
      a.decorateRequest(
        'cookieValue',
        function (this: { headers: { cookie?: string } }, name: string) {
          const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(this.headers.cookie ?? '');
          return m?.[1];
        },
      );
      await a.register(formbody);
      await registerAdmin(a, {
        pool,
        users,
        mfa: new MfaStore(pool, kek),
        audit: new AuditLog(pool),
        sources: new SourceStore(pool, kek),
        issuer: ISSUER,
        cookieKeys: KEYS,
        formActionOrigins: [],
      });
      const admin = await users.create({
        email: 'admin@example.com',
        displayName: 'Admin',
        password: PASSWORD,
      });
      await users.setAdminById(admin.id, true);
      const { rows } = await pool.query<{ id: string }>(
        `WITH s AS (INSERT INTO identity_sources (kind, name, config, enabled)
                    VALUES ('ldap', 'Corp', $1, false) RETURNING id)
         INSERT INTO users (source_id, external_id, username, display_name)
         SELECT id, 'guid-1', 'grace', 'Grace' FROM s RETURNING id`,
        [CORP],
      );
      for (const [lang, text] of [
        ['en', 'next synchronization'],
        ['tr', 'bir sonraki eşitleme'],
      ]) {
        const res = await a.inject({
          url: `/account/admin/accounts/${rows[0]!.id}/delete`,
          headers: { cookie: `${post(admin.id).cookie}; cenacle_id_locale=${lang}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('data-testid="delete-returns"');
        expect(res.body).toContain(text);
        // No address: the sign-in name confirms.
        expect(res.body).toContain('grace');
      }
    } finally {
      await a.close();
      await pool.end();
    }
  });
});
