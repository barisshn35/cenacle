// SPDX-License-Identifier: AGPL-3.0-only
// SCIM 2.0 provisioning by an identity provider.
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/accounts/audit.ts';
import { oidcConfigSchema } from '../src/federation/config.ts';
import { signInFederated } from '../src/federation/people.ts';
import { ProviderStore, type Provider } from '../src/federation/store.ts';
import { registerScim } from '../src/scim/routes.ts';
import { hasTestDatabase, openTestDatabase, resetTestDatabase } from './helpers/db.ts';

describe.skipIf(!hasTestDatabase)('SCIM provisioning (database)', () => {
  let pool: pg.Pool;
  let providers: ProviderStore;
  const app = Fastify();
  let provider: Provider;
  let token: string;

  beforeAll(async () => {
    pool = await openTestDatabase();
    providers = new ProviderStore(pool, randomBytes(32));
    await registerScim(app, {
      pool,
      providers,
      audit: new AuditLog(pool),
      issuer: 'https://id.example.com',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDatabase(pool);
    provider = await providers.create({
      kind: 'oidc',
      name: 'Entra ID',
      enabled: true,
      secret: 'client-secret',
      config: oidcConfigSchema.parse({
        issuer: 'https://login.example.com',
        clientId: 'cenacle',
        adminGroups: ['Cenacle admins'],
      }),
    });
    token = await providers.newScimToken(provider.id);
  });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: object) =>
    app.inject({
      method,
      url: `/scim/v2${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/scim+json' } : {}),
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
  const ada = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'ada@example.com',
    externalId: 'entra-ada',
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    emails: [{ value: 'ada@example.com', type: 'work', primary: true }],
    active: true,
  };

  it('answers only with the provider’s token', async () => {
    for (const authorization of [undefined, 'Bearer scim_wrong', `Basic ${token}`]) {
      const res = await app.inject({
        url: '/scim/v2/Users',
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
    }
    await providers.stopScim(provider.id);
    expect((await call('GET', '/Users')).statusCode).toBe(401);
  });

  it('creates, finds, changes and deactivates people', async () => {
    const created = await call('POST', '/Users', ada);
    expect(created.statusCode).toBe(201);
    expect(created.headers['content-type']).toContain('application/scim+json');
    const user = created.json();
    expect(user).toMatchObject({
      userName: 'ada@example.com',
      displayName: 'Ada Lovelace',
      active: true,
    });
    expect(created.headers.location).toBe(`https://id.example.com/scim/v2/Users/${user.id}`);

    // Providers look up what they made by userName before creating it again.
    const found = await call(
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "ADA@example.com"')}`,
    );
    expect(found.json()).toMatchObject({ totalResults: 1, Resources: [{ id: user.id }] });
    expect((await call('POST', '/Users', ada)).statusCode).toBe(409);
    expect((await call('GET', '/Users?filter=title%20co%20%22x%22')).statusCode).toBe(400);

    // The session the person has ends when the provider turns them off.
    await pool.query(
      `INSERT INTO oidc_payloads (model, id, payload) VALUES ('Session', 's1', $1)`,
      [JSON.stringify({ accountId: user.id })],
    );
    const off = await call('PATCH', `/Users/${user.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'replace', path: 'name.familyName', value: 'King' },
      ],
    });
    expect(off.json()).toMatchObject({ active: false, displayName: 'Ada Lovelace' });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM oidc_payloads WHERE id = 's1'`,
    );
    expect(rows[0].n).toBe(0);
    const replaced = await call('PUT', `/Users/${user.id}`, {
      ...ada,
      displayName: 'Ada King',
      active: true,
    });
    expect(replaced.json()).toMatchObject({ displayName: 'Ada King', active: true });

    expect((await call('DELETE', `/Users/${user.id}`)).statusCode).toBe(204);
    expect((await call('GET', `/Users/${user.id}`)).statusCode).toBe(404);
    const { rows: kept } = await pool.query(
      'SELECT disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1',
      [user.id],
    );
    expect(kept[0].disabled).toBe(true);
  });

  it('keeps groups and the roles they give', async () => {
    const user = (await call('POST', '/Users', ada)).json();
    const group = await call('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Cenacle admins',
      members: [{ value: user.id }],
    });
    expect(group.statusCode).toBe(201);
    const role = async () =>
      (await pool.query('SELECT directory_role FROM users WHERE id = $1', [user.id])).rows[0]
        .directory_role;
    expect(await role()).toBe('admin');
    expect((await call('GET', `/Users/${user.id}`)).json().groups).toEqual([
      { value: group.json().id, display: 'Cenacle admins' },
    ]);

    await call('PATCH', `/Groups/${group.json().id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'remove', path: `members[value eq "${user.id}"]` }],
    });
    expect(await role()).toBe(null);
    await call('PATCH', `/Groups/${group.json().id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: user.id }] }],
    });
    expect(await role()).toBe('admin');
    expect((await call('DELETE', `/Groups/${group.json().id}`)).statusCode).toBe(204);
    expect(await role()).toBe(null);
  });

  it('binds the account to the provider’s id at the first sign-in', async () => {
    const user = (await call('POST', '/Users', ada)).json();
    provider = (await providers.get(provider.id))!;
    const signedIn = await signInFederated(pool, provider, {
      externalId: 'oidc-sub-of-ada',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      emailVerified: true,
      groups: ['ignored'],
    });
    expect(signedIn).toEqual({ userId: user.id });
    // With SCIM on, groups come from SCIM, not from the sign-in.
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM user_groups WHERE user_id = $1',
      [user.id],
    );
    expect(rows[0].n).toBe(0);

    await call('PATCH', `/Users/${user.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false } }],
    });
    expect(
      await signInFederated(pool, provider, {
        externalId: 'oidc-sub-of-ada',
        displayName: 'Ada',
        email: 'ada@example.com',
        emailVerified: true,
        groups: [],
      }),
    ).toEqual({ error: 'disabled' });
  });

  it('links local accounts by address only when asked to, never disabled ones', async () => {
    const linking = await providers.create({
      kind: 'oidc',
      name: 'Okta',
      enabled: true,
      secret: 'client-secret',
      config: oidcConfigSchema.parse({
        issuer: 'https://okta.example.com',
        clientId: 'cenacle',
        linkByEmail: true,
      }),
    });
    token = await providers.newScimToken(linking.id);
    const local = async (email: string, disabled: boolean) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, display_name, password_hash, disabled_at)
         VALUES ($1, 'Local', 'x', CASE WHEN $2 THEN now() END) RETURNING id`,
        [email, disabled],
      );
      return rows[0]!.id;
    };
    const off = await local('ada@example.com', true);
    expect((await call('POST', '/Users', ada)).statusCode).toBe(409);
    const { rows } = await pool.query(
      'SELECT source_id, disabled_at IS NOT NULL AS disabled, password_hash FROM users WHERE id = $1',
      [off],
    );
    expect(rows[0]).toEqual({ source_id: null, disabled: true, password_hash: 'x' });

    const on = await local('grace@example.com', false);
    const linked = await call('POST', '/Users', {
      ...ada,
      userName: 'grace@example.com',
      externalId: 'okta-grace',
      emails: [{ value: 'grace@example.com', primary: true }],
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().id).toBe(on);
  });

  it('writes only the attributes it keeps, never an object prototype', async () => {
    const user = (await call('POST', '/Users', ada)).json();
    const group = (
      await call('POST', '/Groups', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Engineers',
      })
    ).json();
    const patch = (url: string, op: object) =>
      call('PATCH', url, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [op],
      });
    const polluted = () => (({}) as Record<string, unknown>).scimPolluted;
    try {
      for (const [url, op] of [
        [`/Users/${user.id}`, { op: 'add', path: '__proto__.scimPolluted', value: 'yes' }],
        [`/Users/${user.id}`, { op: 'add', path: 'name.__proto__', value: { scimPolluted: 1 } }],
        [`/Users/${user.id}`, { op: 'replace', path: 'constructor.prototype', value: 1 }],
        [`/Groups/${group.id}`, { op: 'replace', value: { '__proto__.scimPolluted': 'yes' } }],
        [
          `/Groups/${group.id}`,
          { op: 'replace', value: JSON.parse('{"__proto__":{"scimPolluted":1}}') },
        ],
      ] as const) {
        const res = await patch(url, op);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ scimType: 'invalidPath' });
        expect(polluted()).toBeUndefined();
      }
      // Filters name only their own columns.
      expect(
        (await call('GET', `/Users?filter=${encodeURIComponent('constructor eq "x"')}`)).statusCode,
      ).toBe(400);
    } finally {
      delete (Object.prototype as Record<string, unknown>).scimPolluted;
    }

    // Attribute names are case-insensitive; those Cenacle does not keep are left out.
    const res = await patch(`/Users/${user.id}`, {
      op: 'replace',
      value: {
        'NAME.familyName': 'King',
        DisplayName: 'Ada King',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department': 'R&D',
        'addresses[type eq "work"].locality': 'London',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ displayName: 'Ada King' });
  });

  it('takes over people who signed in before provisioning', async () => {
    const before = await signInFederated(pool, provider, {
      externalId: 'entra-ada',
      displayName: 'Ada',
      email: 'ada@example.com',
      emailVerified: true,
      groups: [],
    });
    const user = (await call('POST', '/Users', ada)).json();
    expect('userId' in before && user.id).toBe('userId' in before ? before.userId : '');
  });
});
