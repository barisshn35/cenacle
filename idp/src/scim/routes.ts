// SPDX-License-Identifier: AGPL-3.0-only
// SCIM 2.0 (RFC 7643, 7644): an identity provider (Entra ID, Okta, Keycloak, ...)
// pushes its people and groups to Cenacle ID, so they exist, change and are
// deactivated without waiting for a sign-in. Each provider has its own bearer
// token; what it provisions are that provider's accounts, which its sign-ins use.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AuditAction, AuditLog } from '../accounts/audit.ts';
import { endSessions, type Role } from '../directory/store.ts';
import type { Provider, ProviderStore } from '../federation/store.ts';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const CONTENT_TYPE = 'application/scim+json';
const MAX_COUNT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScimOptions {
  pool: pg.Pool;
  providers: ProviderStore;
  audit: AuditLog;
  /** The public origin of Cenacle ID (resource locations). */
  issuer: string;
}

class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
  }
}

/** What Cenacle keeps of a SCIM user. */
interface UserFields {
  userName: string;
  externalId: string | null;
  displayName: string;
  givenName: string;
  familyName: string;
  email: string | null;
  title: string | null;
  active: boolean;
}

interface UserRow {
  id: string;
  scim_user_name: string;
  scim_external_id: string | null;
  display_name: string;
  email: string | null;
  title: string | null;
  disabled: boolean;
  created_at: Date;
  updated_at: Date;
  groups: { value: string; display: string }[];
}

interface GroupRow {
  id: string;
  name: string;
  scim_external_id: string | null;
  members: { value: string; display: string }[];
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

/** SCIM booleans; some providers send "True" and "False" as strings. */
function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return null;
}

function primaryEmail(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const emails = v.filter(
    (e): e is { value: string; primary?: unknown } =>
      typeof e === 'object' && e !== null && typeof (e as { value?: unknown }).value === 'string',
  );
  const chosen = emails.find((e) => bool(e.primary) === true) ?? emails[0];
  const value = chosen ? str(chosen.value, 320) : null;
  return value && /^[^\s@]+@[^\s@]+$/.test(value) ? value : null;
}

/** Reads a User resource (POST, PUT, or a PATCH applied to the current one). */
function userFields(body: Record<string, unknown>): UserFields {
  const userName = str(body.userName, 320);
  if (!userName) throw new ScimError(400, 'userName is required.', 'invalidValue');
  const name = (typeof body.name === 'object' && body.name !== null ? body.name : {}) as Record<
    string,
    unknown
  >;
  const givenName = str(name.givenName, 100) ?? '';
  const familyName = str(name.familyName, 100) ?? '';
  const email = primaryEmail(body.emails);
  const displayName =
    str(body.displayName, 200) ??
    str(name.formatted, 200) ??
    (`${givenName} ${familyName}`.trim() || email || userName).slice(0, 200);
  const active = body.active === undefined ? true : bool(body.active);
  if (active === null) throw new ScimError(400, 'active is a boolean.', 'invalidValue');
  return {
    userName,
    externalId: str(body.externalId, 500),
    displayName,
    givenName,
    familyName,
    email,
    title: str(body.title, 200),
    active,
  };
}

/** Applies PatchOp operations to a resource held as a plain object. */
function applyPatch(resource: Record<string, unknown>, body: Record<string, unknown>) {
  const schemas = body.schemas;
  if (!Array.isArray(schemas) || !schemas.includes(PATCH))
    throw new ScimError(400, 'Not a PatchOp.', 'invalidSyntax');
  const ops = body.Operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 100)
    throw new ScimError(400, 'Operations are required.', 'invalidSyntax');
  for (const raw of ops) {
    const op = typeof raw?.op === 'string' ? raw.op.toLowerCase() : '';
    if (!['add', 'replace', 'remove'].includes(op))
      throw new ScimError(400, 'op is add, replace or remove.', 'invalidSyntax');
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!path) {
      if (op === 'remove' || typeof raw.value !== 'object' || raw.value === null)
        throw new ScimError(400, 'A path or an object value is required.', 'noTarget');
      for (const [k, v] of Object.entries(raw.value as Record<string, unknown>)) {
        if (k.includes('.')) setPath(resource, k, v);
        else resource[k] = v;
      }
      continue;
    }
    if (path === 'members' || path.startsWith('members[')) {
      patchMembers(resource, op, path, raw.value);
      continue;
    }
    if (/^emails(\[.*\])?(\.value)?$/i.test(path)) {
      // One address is kept: any e-mail path sets or removes it.
      const value =
        op === 'remove'
          ? null
          : Array.isArray(raw.value)
            ? primaryEmail(raw.value)
            : str(raw.value, 320);
      resource.emails = value ? [{ value, primary: true }] : [];
      continue;
    }
    setPath(resource, path, op === 'remove' ? undefined : raw.value);
  }
}

function setPath(resource: Record<string, unknown>, path: string, value: unknown) {
  const [head, tail] = path.replace(/^urn:[^:]+(:[^:]+)*:/i, '').split('.', 2) as [string, string?];
  if (!tail) {
    resource[head] = value;
    return;
  }
  const inner = (
    typeof resource[head] === 'object' && resource[head] !== null ? resource[head] : {}
  ) as Record<string, unknown>;
  inner[tail] = value;
  resource[head] = inner;
}

function patchMembers(resource: Record<string, unknown>, op: string, path: string, value: unknown) {
  const current = (Array.isArray(resource.members) ? resource.members : []) as {
    value: string;
  }[];
  const given = (Array.isArray(value) ? value : value ? [value] : [])
    .map((m) => (typeof m === 'object' && m !== null ? (m as { value?: unknown }).value : null))
    .filter((v): v is string => typeof v === 'string');
  const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path)?.[1];
  if (op === 'remove') {
    const drop = new Set(filtered ? [filtered] : given);
    // remove without a filter or values empties the group.
    resource.members = filtered || given.length ? current.filter((m) => !drop.has(m.value)) : [];
  } else if (op === 'add') {
    const have = new Set(current.map((m) => m.value));
    resource.members = [
      ...current,
      ...given.filter((v) => !have.has(v)).map((v) => ({ value: v })),
    ];
  } else {
    resource.members = given.map((v) => ({ value: v }));
  }
}

/** `attribute eq "value"`: the filters providers use to find what they made. */
function parseFilter(filter: string | undefined, allowed: Record<string, string>) {
  if (!filter) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const column = m ? allowed[m[1]!.toLowerCase()] : undefined;
  if (!m || !column) throw new ScimError(400, 'Unsupported filter.', 'invalidFilter');
  return { column, value: m[2]!.replace(/\\(.)/g, '$1') };
}

const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

/** Role from the provider's admin and guest groups, as at a sign-in. */
function roleOf(provider: Provider, groups: string[]): Role {
  const inAny = (wanted: string[]) => wanted.some((g) => groups.includes(g));
  return inAny(provider.config.adminGroups)
    ? 'admin'
    : inAny(provider.config.guestGroups)
      ? 'guest'
      : null;
}

/**
 * Sets the role of these people from their groups and marks them changed (the
 * chat's directory feed follows).
 */
export async function refreshRoles(
  db: pg.Pool | pg.PoolClient,
  provider: Provider,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const { rows } = await db.query<{ id: string; groups: string[] }>(
    `SELECT u.id, coalesce(array_agg(g.name) FILTER (WHERE g.id IS NOT NULL), '{}') AS groups
     FROM users u LEFT JOIN user_groups ug ON ug.user_id = u.id
     LEFT JOIN directory_groups g ON g.id = ug.group_id
     WHERE u.id = ANY($1::uuid[]) AND u.source_id = $2 GROUP BY u.id`,
    [userIds, provider.id],
  );
  for (const r of rows) {
    await db.query(`UPDATE users SET directory_role = $2, updated_at = now() WHERE id = $1`, [
      r.id,
      roleOf(provider, r.groups),
    ]);
  }
}

export async function registerScim(app: FastifyInstance, opts: ScimOptions): Promise<void> {
  const { pool, providers, audit } = opts;
  const base = `${opts.issuer.replace(/\/$/, '')}/scim/v2`;

  await app.register(
    async (scim) => {
      scim.addContentTypeParser(CONTENT_TYPE, { parseAs: 'string' }, (_req, body, done) => {
        try {
          done(null, body === '' ? {} : JSON.parse(body as string));
        } catch {
          done(new ScimError(400, 'The body is not JSON.', 'invalidSyntax'), undefined);
        }
      });

      scim.decorateRequest('scimProvider', null);
      scim.addHook('onRequest', async (request, reply) => {
        const m = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
        const provider = m ? await providers.byScimToken(m[1]!) : null;
        if (!provider) {
          reply.header('www-authenticate', 'Bearer realm="cenacle-id-scim"');
          return send(reply, 401, error(401, 'A valid SCIM token is required.'));
        }
        (request as ScimRequest).scimProvider = provider;
      });

      scim.setErrorHandler((err, request, reply) => {
        if (err instanceof ScimError)
          return send(reply, err.status, error(err.status, err.message, err.scimType));
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500)
          return send(reply, status, error(status, (err as Error).message));
        request.log.error({ err }, 'scim request failed');
        return send(reply, 500, error(500, 'The request failed.'));
      });

      scim.get('/ServiceProviderConfig', async (_request, reply) =>
        send(reply, 200, {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: MAX_COUNT },
          changePassword: { supported: false },
          sort: { supported: false },
          etag: { supported: false },
          authenticationSchemes: [
            {
              type: 'oauthbearertoken',
              name: 'Bearer token',
              description: 'The token shown when SCIM is turned on for the provider.',
            },
          ],
        }),
      );
      scim.get('/ResourceTypes', async (_request, reply) =>
        send(reply, 200, {
          schemas: [LIST],
          totalResults: 2,
          Resources: [
            { id: 'User', name: 'User', endpoint: '/Users', schema: USER },
            { id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP },
          ].map((r) => ({
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
            ...r,
          })),
        }),
      );
      scim.get('/Schemas', async (_request, reply) =>
        send(reply, 200, {
          schemas: [LIST],
          totalResults: 2,
          Resources: [
            { id: USER, name: 'User' },
            { id: GROUP, name: 'Group' },
          ],
        }),
      );

      // People.
      const userSelect = `SELECT u.id, u.scim_user_name, u.scim_external_id, u.display_name, u.email, u.title,
          u.disabled_at IS NOT NULL AS disabled, u.created_at, u.updated_at,
          coalesce((SELECT json_agg(json_build_object('value', g.id, 'display', g.name) ORDER BY g.name)
                    FROM user_groups ug JOIN directory_groups g ON g.id = ug.group_id
                    WHERE ug.user_id = u.id), '[]') AS groups
        FROM users u`;
      const userResource = (r: UserRow) => {
        const [givenName, ...rest] = r.display_name.split(' ');
        return {
          schemas: [USER],
          id: r.id,
          ...(r.scim_external_id ? { externalId: r.scim_external_id } : {}),
          userName: r.scim_user_name,
          displayName: r.display_name,
          name: { formatted: r.display_name, givenName, familyName: rest.join(' ') },
          emails: r.email ? [{ value: r.email, type: 'work', primary: true }] : [],
          ...(r.title ? { title: r.title } : {}),
          active: !r.disabled,
          groups: r.groups,
          meta: {
            resourceType: 'User',
            created: r.created_at.toISOString(),
            lastModified: r.updated_at.toISOString(),
            location: `${base}/Users/${r.id}`,
          },
        };
      };
      const getUser = async (provider: Provider, id: string): Promise<UserRow> => {
        if (!UUID.test(id)) throw new ScimError(404, 'No such user.');
        const { rows } = await pool.query<UserRow>(
          `${userSelect} WHERE u.id = $1 AND u.source_id = $2 AND u.scim_managed`,
          [id, provider.id],
        );
        if (!rows[0]) throw new ScimError(404, 'No such user.');
        return rows[0];
      };

      /** Writes a user's fields; returns whether it was deactivated now. */
      const saveUser = async (
        request: FastifyRequest,
        provider: Provider,
        id: string | null,
        f: UserFields,
      ): Promise<string> => {
        try {
          if (id === null) {
            // Someone who signed in before provisioning started (or, with
            // linkByEmail, a local account with the address) becomes managed.
            // A disabled local account is not revived by linking it: its
            // address makes the new account a conflict (409) instead.
            const { rows: existing } = await pool.query<{ id: string }>(
              `SELECT id FROM users
               WHERE NOT scim_managed AND (
                 (source_id = $1 AND (external_id = $2 OR ($3::citext IS NOT NULL AND email = $3::citext)))
                 OR ($4 AND source_id IS NULL AND disabled_at IS NULL
                     AND $3::citext IS NOT NULL AND email = $3::citext))
               ORDER BY source_id NULLS LAST LIMIT 1`,
              [provider.id, f.externalId ?? f.userName, f.email, provider.config.linkByEmail],
            );
            if (existing[0]) {
              await pool.query(
                `UPDATE users SET source_id = $2, external_id = coalesce(external_id, $3),
                   password_hash = NULL, scim_managed = true WHERE id = $1`,
                [existing[0].id, provider.id, f.externalId ?? f.userName],
              );
              return saveUser(request, provider, existing[0].id, f);
            }
            const { rows } = await pool.query<{ id: string }>(
              `INSERT INTO users (source_id, external_id, scim_external_id, scim_user_name, scim_managed,
                                  display_name, email, email_verified, title, synced_at, disabled_at)
               VALUES ($1, $2, $3, $4, true, $5, $6::citext, $6::citext IS NOT NULL, $7, now(),
                       CASE WHEN $8 THEN NULL ELSE now() END)
               RETURNING id`,
              [
                provider.id,
                f.externalId ?? f.userName,
                f.externalId,
                f.userName,
                f.displayName,
                f.email,
                f.title,
                f.active,
              ],
            );
            await record(request, 'scim.user.created', provider, { user: rows[0]!.id });
            return rows[0]!.id;
          }
          const { rows } = await pool.query<{ was_active: boolean }>(
            `UPDATE users u SET scim_external_id = $3, scim_user_name = $4, display_name = $5,
                 email = $6::citext, email_verified = $6::citext IS NOT NULL, title = $7, synced_at = now(),
                 disabled_at = CASE WHEN $8 THEN NULL ELSE coalesce(u.disabled_at, now()) END,
                 updated_at = now()
               FROM (SELECT disabled_at IS NULL AS was_active FROM users WHERE id = $1) old
               WHERE u.id = $1 AND u.source_id = $2
               RETURNING old.was_active`,
            [id, provider.id, f.externalId, f.userName, f.displayName, f.email, f.title, f.active],
          );
          if (rows[0]?.was_active && !f.active) {
            await endSessions(pool, [id]);
            await record(request, 'scim.user.deactivated', provider, { user: id });
          } else {
            await record(request, 'scim.user.updated', provider, { user: id });
          }
          return id;
        } catch (err) {
          if (isUnique(err))
            throw new ScimError(
              409,
              'Another account has this userName or e-mail address.',
              'uniqueness',
            );
          throw err;
        }
      };

      scim.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>(
        '/Users',
        async (request, reply) => {
          const provider = providerOf(request);
          const filter = parseFilter(request.query.filter, {
            username: 'lower(u.scim_user_name) = lower($2)',
            externalid: 'u.scim_external_id = $2',
            'emails.value': 'u.email = $2::citext',
          });
          const { start, count } = paging(request.query);
          const where = `u.source_id = $1 AND u.scim_managed${filter ? ` AND ${filter.column}` : ''}`;
          const args: unknown[] = [provider.id, ...(filter ? [filter.value] : [])];
          const total = await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM users u WHERE ${where}`,
            args,
          );
          const { rows } = await pool.query<UserRow>(
            `${userSelect} WHERE ${where} ORDER BY u.id LIMIT ${count} OFFSET ${start - 1}`,
            args,
          );
          return send(reply, 200, listOf(Number(total.rows[0]!.n), start, rows.map(userResource)));
        },
      );

      scim.post<{ Body: Record<string, unknown> }>('/Users', async (request, reply) => {
        const provider = providerOf(request);
        const id = await saveUser(request, provider, null, userFields(request.body ?? {}));
        return send(reply, 201, userResource(await getUser(provider, id)), `${base}/Users/${id}`);
      });

      scim.get<{ Params: { id: string } }>('/Users/:id', async (request, reply) =>
        send(reply, 200, userResource(await getUser(providerOf(request), request.params.id))),
      );

      scim.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
        '/Users/:id',
        async (request, reply) => {
          const provider = providerOf(request);
          const current = await getUser(provider, request.params.id);
          await saveUser(request, provider, current.id, userFields(request.body ?? {}));
          return send(reply, 200, userResource(await getUser(provider, current.id)));
        },
      );

      scim.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
        '/Users/:id',
        async (request, reply) => {
          const provider = providerOf(request);
          const current = await getUser(provider, request.params.id);
          const resource: Record<string, unknown> = userResource(current);
          applyPatch(resource, request.body ?? {});
          await saveUser(request, provider, current.id, userFields(resource));
          return send(reply, 200, userResource(await getUser(provider, current.id)));
        },
      );

      scim.delete<{ Params: { id: string } }>('/Users/:id', async (request, reply) => {
        const provider = providerOf(request);
        const current = await getUser(provider, request.params.id);
        // The account stays (messages keep their author) but is off and no
        // longer the provider's to manage.
        await pool.query(
          `UPDATE users SET scim_managed = false, disabled_at = coalesce(disabled_at, now()), updated_at = now()
           WHERE id = $1`,
          [current.id],
        );
        await pool.query(`DELETE FROM user_groups WHERE user_id = $1`, [current.id]);
        await endSessions(pool, [current.id]);
        await record(request, 'scim.user.deleted', provider, { user: current.id });
        return reply.code(204).send();
      });

      // Groups.
      const groupSelect = `SELECT g.id, g.name, g.scim_external_id,
          coalesce((SELECT json_agg(json_build_object('value', u.id, 'display', u.display_name) ORDER BY u.display_name)
                    FROM user_groups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = g.id), '[]') AS members
        FROM directory_groups g`;
      const groupResource = (g: GroupRow, members = true) => ({
        schemas: [GROUP],
        id: g.id,
        ...(g.scim_external_id ? { externalId: g.scim_external_id } : {}),
        displayName: g.name,
        ...(members ? { members: g.members } : {}),
        meta: { resourceType: 'Group', location: `${base}/Groups/${g.id}` },
      });
      const getGroup = async (provider: Provider, id: string): Promise<GroupRow> => {
        if (!UUID.test(id)) throw new ScimError(404, 'No such group.');
        const { rows } = await pool.query<GroupRow>(
          `${groupSelect} WHERE g.id = $1 AND g.source_id = $2 AND g.scim_managed`,
          [id, provider.id],
        );
        if (!rows[0]) throw new ScimError(404, 'No such group.');
        return rows[0];
      };

      /** Writes a group and its members; the people whose groups changed get their role again. */
      const saveGroup = async (
        request: FastifyRequest,
        provider: Provider,
        id: string | null,
        body: Record<string, unknown>,
      ): Promise<string> => {
        const name = str(body.displayName, 200);
        if (!name) throw new ScimError(400, 'displayName is required.', 'invalidValue');
        const members = Array.isArray(body.members)
          ? [
              ...new Set(
                body.members
                  .map((m) => (m as { value?: unknown })?.value)
                  .filter((v): v is string => typeof v === 'string' && UUID.test(v)),
              ),
            ]
          : null;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          let groupId = id;
          // Groups are matched by name, as at sign-ins and in the admin and guest groups.
          if (groupId === null) {
            const { rows } = await client.query<{ id: string }>(
              `INSERT INTO directory_groups (source_id, external_id, name, scim_managed, scim_external_id)
               VALUES ($1, $2, $2, true, $3)
               ON CONFLICT (source_id, external_id) DO UPDATE SET scim_managed = true,
                 scim_external_id = EXCLUDED.scim_external_id
               WHERE NOT directory_groups.scim_managed
               RETURNING id`,
              [provider.id, name, str(body.externalId, 500)],
            );
            if (!rows[0]) throw new ScimError(409, 'A group has this name.', 'uniqueness');
            groupId = rows[0].id;
          } else {
            await client.query(
              `UPDATE directory_groups SET external_id = $3, name = $3, scim_external_id = $4
               WHERE id = $1 AND source_id = $2`,
              [groupId, provider.id, name, str(body.externalId, 500)],
            );
          }
          const affected = new Set<string>();
          if (members !== null) {
            const { rows: valid } = await client.query<{ id: string }>(
              `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND source_id = $2`,
              [members, provider.id],
            );
            const wanted = valid.map((r) => r.id);
            const { rows: removed } = await client.query<{ user_id: string }>(
              `DELETE FROM user_groups WHERE group_id = $1 AND NOT (user_id = ANY($2::uuid[]))
               RETURNING user_id`,
              [groupId, wanted],
            );
            const { rows: added } = await client.query<{ user_id: string }>(
              `INSERT INTO user_groups (user_id, group_id) SELECT unnest($2::uuid[]), $1
               ON CONFLICT DO NOTHING RETURNING user_id`,
              [groupId, wanted],
            );
            for (const r of [...removed, ...added]) affected.add(r.user_id);
          }
          if (id !== null && members === null) {
            // A rename changes the groups of everyone in it.
            const { rows } = await client.query<{ user_id: string }>(
              'SELECT user_id FROM user_groups WHERE group_id = $1',
              [groupId],
            );
            for (const r of rows) affected.add(r.user_id);
          }
          await refreshRoles(client, provider, [...affected]);
          await client.query('COMMIT');
          await record(request, 'scim.group.changed', provider, { group: groupId });
          return groupId;
        } catch (err) {
          await client.query('ROLLBACK');
          if (isUnique(err)) throw new ScimError(409, 'A group has this name.', 'uniqueness');
          throw err;
        } finally {
          client.release();
        }
      };

      scim.get<{
        Querystring: {
          filter?: string;
          startIndex?: string;
          count?: string;
          excludedAttributes?: string;
        };
      }>('/Groups', async (request, reply) => {
        const provider = providerOf(request);
        const filter = parseFilter(request.query.filter, {
          displayname: 'g.name = $2',
          externalid: 'g.scim_external_id = $2',
        });
        const { start, count } = paging(request.query);
        const where = `g.source_id = $1 AND g.scim_managed${filter ? ` AND ${filter.column}` : ''}`;
        const args: unknown[] = [provider.id, ...(filter ? [filter.value] : [])];
        const total = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM directory_groups g WHERE ${where}`,
          args,
        );
        const { rows } = await pool.query<GroupRow>(
          `${groupSelect} WHERE ${where} ORDER BY g.id LIMIT ${count} OFFSET ${start - 1}`,
          args,
        );
        const members = !/\bmembers\b/.test(request.query.excludedAttributes ?? '');
        return send(
          reply,
          200,
          listOf(
            Number(total.rows[0]!.n),
            start,
            rows.map((g) => groupResource(g, members)),
          ),
        );
      });

      scim.post<{ Body: Record<string, unknown> }>('/Groups', async (request, reply) => {
        const provider = providerOf(request);
        const id = await saveGroup(request, provider, null, request.body ?? {});
        return send(
          reply,
          201,
          groupResource(await getGroup(provider, id)),
          `${base}/Groups/${id}`,
        );
      });

      scim.get<{ Params: { id: string } }>('/Groups/:id', async (request, reply) =>
        send(reply, 200, groupResource(await getGroup(providerOf(request), request.params.id))),
      );

      scim.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
        '/Groups/:id',
        async (request, reply) => {
          const provider = providerOf(request);
          const current = await getGroup(provider, request.params.id);
          await saveGroup(request, provider, current.id, {
            members: [],
            ...(request.body ?? {}),
          });
          return send(reply, 200, groupResource(await getGroup(provider, current.id)));
        },
      );

      scim.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
        '/Groups/:id',
        async (request, reply) => {
          const provider = providerOf(request);
          const current = await getGroup(provider, request.params.id);
          const resource: Record<string, unknown> = groupResource(current);
          applyPatch(resource, request.body ?? {});
          await saveGroup(request, provider, current.id, resource);
          // Providers often ask for no body back; the group is small enough to send.
          return send(reply, 200, groupResource(await getGroup(provider, current.id)));
        },
      );

      scim.delete<{ Params: { id: string } }>('/Groups/:id', async (request, reply) => {
        const provider = providerOf(request);
        const current = await getGroup(provider, request.params.id);
        const { rows } = await pool.query<{ user_id: string }>(
          'SELECT user_id FROM user_groups WHERE group_id = $1',
          [current.id],
        );
        await pool.query('DELETE FROM directory_groups WHERE id = $1', [current.id]);
        await refreshRoles(
          pool,
          provider,
          rows.map((r) => r.user_id),
        );
        await record(request, 'scim.group.changed', provider, {
          group: current.id,
          deleted: true,
        });
        return reply.code(204).send();
      });
    },
    { prefix: '/scim/v2' },
  );

  function record(
    request: FastifyRequest,
    action: AuditAction,
    provider: Provider,
    detail: Record<string, unknown>,
  ) {
    return audit.record(action, null, request.ip, { provider: provider.id, ...detail });
  }
}

interface ScimRequest extends FastifyRequest {
  scimProvider: Provider | null;
}

function providerOf(request: FastifyRequest): Provider {
  return (request as ScimRequest).scimProvider!;
}

function paging(q: { startIndex?: string; count?: string }) {
  const start = Math.max(1, Math.trunc(Number(q.startIndex ?? 1)) || 1);
  const count = Math.min(MAX_COUNT, Math.max(0, Math.trunc(Number(q.count ?? 100)) || 0));
  return { start, count: q.count === undefined ? 100 : count };
}

function listOf(total: number, start: number, resources: unknown[]) {
  return {
    schemas: [LIST],
    totalResults: total,
    startIndex: start,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function error(status: number, detail: string, scimType?: string) {
  return { schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) };
}

function send(reply: FastifyReply, status: number, body: unknown, location?: string) {
  if (location) reply.header('location', location);
  return reply
    .code(status)
    .header('content-type', CONTENT_TYPE)
    .header('cache-control', 'no-store')
    .send(JSON.stringify(body));
}
