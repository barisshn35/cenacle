// SPDX-License-Identifier: AGPL-3.0-only
// Identity sources of kind ldap (directories) and what Cenacle ID keeps of
// their people and groups. Identity providers (oidc, saml): federation/store.ts.
import type pg from 'pg';
import { openPrivateKey, sealPrivateKey } from '../keys/crypto.ts';
import { ldapConfigSchema, sameBindTarget, type DirectoryPerson, type LdapConfig } from './ldap.ts';

export interface Source {
  id: string;
  kind: 'ldap';
  name: string;
  config: LdapConfig;
  hasSecret: boolean;
  enabled: boolean;
  syncIntervalMinutes: number;
  lastSyncAt: Date | null;
}

interface SourceRow {
  id: string;
  kind: 'ldap';
  name: string;
  config: unknown;
  secret_enc: Buffer | null;
  enabled: boolean;
  sync_interval_minutes: number;
  last_sync_at: Date | null;
}

export interface SyncRun {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  startedAt: Date;
  finishedAt: Date | null;
  usersSeen: number;
  usersCreated: number;
  usersUpdated: number;
  usersDeactivated: number;
  usersSkipped: number;
  groups: number;
  /** Why it failed, or which people it skipped. */
  error: string;
}

export interface SyncCounts {
  usersSeen: number;
  usersCreated: number;
  usersUpdated: number;
  usersDeactivated: number;
  /** People listed but not kept (their sign-in name belongs to another account). */
  usersSkipped: number;
  groups: number;
}

function toSource(r: SourceRow): Source {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: ldapConfigSchema.parse(r.config),
    hasSecret: r.secret_enc !== null,
    enabled: r.enabled,
    syncIntervalMinutes: r.sync_interval_minutes,
    lastSyncAt: r.last_sync_at,
  };
}

const SOURCE_COLUMNS =
  'id, kind, name, config, secret_enc, enabled, sync_interval_minutes, last_sync_at';

export class SourceStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly kek: Buffer,
  ) {}

  async list(): Promise<Source[]> {
    const { rows } = await this.pool.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM identity_sources WHERE kind = 'ldap' ORDER BY created_at`,
    );
    return rows.map(toSource);
  }

  async get(id: string): Promise<Source | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM identity_sources WHERE id = $1 AND kind = 'ldap'`,
      [id],
    );
    return rows[0] ? toSource(rows[0]) : null;
  }

  /** The bind password, decrypted (bound to the source id). */
  async secret(id: string): Promise<string> {
    const { rows } = await this.pool.query<{ secret_enc: Buffer | null }>(
      'SELECT secret_enc FROM identity_sources WHERE id = $1',
      [id],
    );
    const sealed = rows[0]?.secret_enc;
    return sealed ? openPrivateKey(this.kek, `source:${id}`, sealed) : '';
  }

  async create(input: {
    name: string;
    config: LdapConfig;
    secret: string;
    syncIntervalMinutes: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<SourceRow>(
        `INSERT INTO identity_sources (kind, name, config, sync_interval_minutes)
         VALUES ('ldap', $1, $2, $3) RETURNING ${SOURCE_COLUMNS}`,
        [input.name, JSON.stringify(input.config), input.syncIntervalMinutes],
      );
      const row = rows[0]!;
      if (input.secret) {
        await client.query('UPDATE identity_sources SET secret_enc = $2 WHERE id = $1', [
          row.id,
          sealPrivateKey(this.kek, `source:${row.id}`, input.secret),
        ]);
      }
      await client.query('COMMIT');
      return (await this.get(row.id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Changes settings; a secret of undefined keeps the stored one, unless the
   * settings send it elsewhere (sameBindTarget): then it is dropped.
   */
  async update(
    id: string,
    input: {
      name: string;
      config: LdapConfig;
      secret?: string;
      enabled: boolean;
      syncIntervalMinutes: number;
    },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ config: unknown }>(
        `SELECT config FROM identity_sources WHERE id = $1 AND kind = 'ldap' FOR UPDATE`,
        [id],
      );
      const saved = rows[0] ? ldapConfigSchema.safeParse(rows[0].config) : null;
      const secret =
        input.secret === undefined && !(saved?.success && sameBindTarget(saved.data, input.config))
          ? ''
          : input.secret;
      await client.query(
        `UPDATE identity_sources SET name = $2, config = $3, enabled = $4, sync_interval_minutes = $5,
           secret_enc = CASE WHEN $6::boolean THEN $7 ELSE secret_enc END, updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.name,
          JSON.stringify(input.config),
          input.enabled,
          input.syncIntervalMinutes,
          secret !== undefined,
          secret ? sealPrivateKey(this.kek, `source:${id}`, secret) : null,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async startRun(sourceId: string, trigger: SyncRun['trigger']): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO sync_runs (source_id, trigger) VALUES ($1, $2) RETURNING id`,
      [sourceId, trigger],
    );
    return rows[0]!.id;
  }

  /** Ends a run: failed with `error`, or succeeded with counts (and what it skipped). */
  async finishRun(
    runId: string,
    sourceId: string,
    counts: SyncCounts | null,
    error = '',
    skipped = '',
  ): Promise<void> {
    await this.pool.query(
      `UPDATE sync_runs SET status = $2, finished_at = now(), users_seen = $3, users_created = $4,
         users_updated = $5, users_deactivated = $6, groups = $7, error = $8, users_skipped = $9
       WHERE id = $1`,
      [
        runId,
        error ? 'failed' : 'succeeded',
        counts?.usersSeen ?? 0,
        counts?.usersCreated ?? 0,
        counts?.usersUpdated ?? 0,
        counts?.usersDeactivated ?? 0,
        counts?.groups ?? 0,
        (error || skipped).slice(0, 2000),
        counts?.usersSkipped ?? 0,
      ],
    );
    if (!error) {
      await this.pool.query('UPDATE identity_sources SET last_sync_at = now() WHERE id = $1', [
        sourceId,
      ]);
    }
  }

  async runs(sourceId: string, limit = 20): Promise<SyncRun[]> {
    const { rows } = await this.pool.query(
      `SELECT id, trigger, status, started_at, finished_at, users_seen, users_created, users_updated,
         users_deactivated, users_skipped, groups, error FROM sync_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [sourceId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      usersSeen: r.users_seen,
      usersCreated: r.users_created,
      usersUpdated: r.users_updated,
      usersDeactivated: r.users_deactivated,
      usersSkipped: r.users_skipped,
      groups: r.groups,
      error: r.error,
    }));
  }

  /** Sources whose next scheduled sync is due. */
  async due(): Promise<Source[]> {
    const { rows } = await this.pool.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM identity_sources
       WHERE kind = 'ldap' AND enabled AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(mins => sync_interval_minutes))`,
    );
    return rows.map(toSource);
  }
}

export type Role = 'admin' | 'guest' | null;

/**
 * The name apps see for a group (SQL expression over a source's kind and
 * name and the group's name): a directory's by name, an identity provider's
 * as "<provider>/<name>" with "/" in the provider's name as "-" (ADR 0045).
 * Changing it changes every group's name for apps: record the changes in
 * group_name_changes (ADR 0046) as migration 0011 did for this rule.
 */
export const appGroupName = (kind: string, sourceName: string, groupName: string) =>
  `CASE WHEN ${kind} = 'ldap' THEN ${groupName} ELSE replace(${sourceName}, '/', '-') || '/' || ${groupName} END`;

/**
 * The groups of user $1 as apps see them (the groups claim, the directory
 * feed): a directory's by name, an identity provider's as "<provider>/<name>"
 * ("/" in the provider's name becomes "-"), so a provider can never name a
 * group like a directory's or another provider's (ADR 0045). Longer than 200
 * characters, the most an app keeps: left out.
 */
export const APP_GROUPS_SQL = `SELECT n FROM (
    SELECT ${appGroupName('s.kind', 's.name', 'g.name')} AS n
    FROM user_groups ug JOIN directory_groups g ON g.id = ug.group_id
    JOIN identity_sources s ON s.id = g.source_id WHERE ug.user_id = $1) app_groups
  WHERE char_length(n) <= 200`;

/**
 * Writes a person from a directory: created at first sight, refreshed (name,
 * address, title, role, photo, groups) every time; reactivated if they come
 * back. With linkByEmail (the source's opt-in), an existing local account with
 * the same address becomes the directory account; a disabled one is never
 * linked (and so never revived). Without linkPrivileged, administrators of
 * Cenacle ID and accounts with a second step are not linked either (identity
 * providers' accounts sign in there, without the second step). Returns the
 * user id and whether the account was created or changed.
 */
export async function upsertPerson(
  db: pg.Pool | pg.PoolClient,
  sourceId: string,
  // Accounts of identity providers have no sign-in name (federation/people.ts).
  person: Omit<DirectoryPerson, 'username'> & { username: string | null },
  role: Role,
  groupIds: string[] | null,
  linkByEmail: boolean,
  linkPrivileged = true,
): Promise<{ id: string; created: boolean; changed: boolean }> {
  if (person.email && linkByEmail) {
    await db.query(
      `UPDATE users SET source_id = $1, external_id = $2, password_hash = NULL, updated_at = now()
       WHERE source_id IS NULL AND email = $3::citext AND disabled_at IS NULL AND admin_disabled_at IS NULL
         AND ($4 OR (NOT is_admin AND totp_enabled_at IS NULL))
         AND NOT EXISTS (SELECT 1 FROM users WHERE source_id = $1 AND external_id = $2)`,
      [sourceId, person.externalId, person.email, linkPrivileged],
    );
  }
  const upsert = (email: string | null) =>
    db.query<{ id: string; created: boolean; changed: boolean }>(
      `INSERT INTO users (source_id, external_id, username, display_name, email, email_verified, title,
                          directory_role, synced_at)
       VALUES ($1, $2, $3, $4, $5::citext, $5::citext IS NOT NULL, $6, $7::text, now())
       ON CONFLICT (source_id, external_id) WHERE source_id IS NOT NULL DO UPDATE SET
         username = EXCLUDED.username, display_name = EXCLUDED.display_name, email = EXCLUDED.email,
         email_verified = EXCLUDED.email_verified, title = EXCLUDED.title,
         directory_role = EXCLUDED.directory_role, synced_at = now(), disabled_at = NULL,
         updated_at = CASE WHEN (users.username, users.display_name, users.email, users.title,
                                 users.directory_role, users.disabled_at IS NOT NULL)
                               IS DISTINCT FROM (EXCLUDED.username, EXCLUDED.display_name, EXCLUDED.email,
                                                 EXCLUDED.title, EXCLUDED.directory_role, false)
                           THEN now() ELSE users.updated_at END
       RETURNING id, (xmax = 0) AS created, (updated_at = now()) AS changed`,
      [sourceId, person.externalId, person.username, person.displayName, email, person.title, role],
    );
  let rows;
  try {
    ({ rows } = await upsert(person.email));
  } catch (err) {
    // The address (or sign-in name) belongs to another account: keep the
    // person, without the address.
    if ((err as { code?: string }).code !== '23505') throw err;
    ({ rows } = await upsert(null));
  }
  const row = rows[0]!;
  // A new or removed photo is a change of the account (the chat follows it).
  const photo = person.photo
    ? await db.query(
        `WITH old AS (SELECT data FROM user_photos WHERE user_id = $1 AND origin = 'directory')
         INSERT INTO user_photos (user_id, origin, content_type, data) VALUES ($1, 'directory', $2, $3)
         ON CONFLICT (user_id, origin) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data,
           updated_at = CASE WHEN user_photos.data = EXCLUDED.data THEN user_photos.updated_at ELSE now() END
         RETURNING (SELECT data FROM old) IS DISTINCT FROM $3 AS changed`,
        [row.id, sniffImage(person.photo), person.photo],
      )
    : await db.query(
        `DELETE FROM user_photos WHERE user_id = $1 AND origin = 'directory' RETURNING true AS changed`,
        [row.id],
      );
  if (photo.rows[0]?.changed && !row.created) {
    await db.query('UPDATE users SET updated_at = now() WHERE id = $1', [row.id]);
    row.changed = true;
  }
  if (groupIds) {
    const { rows: changed } = await db.query<{ n: number }>(
      `WITH wanted AS (SELECT unnest($2::uuid[]) AS group_id),
       removed AS (DELETE FROM user_groups WHERE user_id = $1 AND group_id NOT IN (SELECT group_id FROM wanted) RETURNING 1),
       added AS (INSERT INTO user_groups (user_id, group_id) SELECT $1, group_id FROM wanted ON CONFLICT DO NOTHING RETURNING 1)
       SELECT (SELECT count(*) FROM removed) + (SELECT count(*) FROM added) AS n`,
      [row.id, groupIds],
    );
    if (Number(changed[0]!.n) > 0 && !row.created) {
      // Group changes are changes of the account (the chat follows them).
      await db.query('UPDATE users SET updated_at = now() WHERE id = $1', [row.id]);
      row.changed = true;
    }
  }
  return row;
}

function sniffImage(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (data.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}

/** Writes the groups of a directory and returns their ids by external id. */
export async function upsertGroups(
  db: pg.Pool | pg.PoolClient,
  sourceId: string,
  groups: { externalId: string; name: string; dn: string }[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const g of groups) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO directory_groups (source_id, external_id, name, dn) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, external_id) DO UPDATE SET name = EXCLUDED.name, dn = EXCLUDED.dn
       RETURNING id`,
      [sourceId, g.externalId, g.name.slice(0, 200), g.dn],
    );
    ids.set(g.externalId, rows[0]!.id);
  }
  await db.query(
    `DELETE FROM directory_groups WHERE source_id = $1 AND NOT (external_id = ANY($2::text[]))`,
    [sourceId, groups.map((g) => g.externalId)],
  );
  return ids;
}

/** Writes groups seen at a sign-in (others are kept until the next sync). */
export async function ensureGroups(
  db: pg.Pool | pg.PoolClient,
  sourceId: string,
  groups: { externalId: string; name: string; dn: string }[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const g of groups) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO directory_groups (source_id, external_id, name, dn) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, external_id) DO UPDATE SET name = EXCLUDED.name, dn = EXCLUDED.dn
       RETURNING id`,
      [sourceId, g.externalId, g.name.slice(0, 200), g.dn],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

/**
 * Deactivates the people of a source that the directory no longer lists (gone
 * or disabled) and ends their Cenacle ID sessions and grants.
 */
export async function deactivateMissing(
  db: pg.Pool,
  sourceId: string,
  seen: string[],
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE users SET disabled_at = now(), updated_at = now()
     WHERE source_id = $1 AND disabled_at IS NULL AND NOT (external_id = ANY($2::text[]))
     RETURNING id`,
    [sourceId, seen],
  );
  if (rows.length > 0)
    await endSessions(
      db,
      rows.map((r) => r.id),
    );
  return rows.length;
}

/**
 * Ends every Cenacle ID session and grant of these accounts, and their
 * account pages' sign-ins (account/session.ts), but for `keepAccountPagesOf`
 * (the administrator making the change).
 */
export async function endSessions(
  db: pg.Pool | pg.PoolClient,
  userIds: string[],
  keepAccountPagesOf?: string,
): Promise<void> {
  await db.query(
    `DELETE FROM oidc_payloads WHERE model IN ('Session', 'Grant', 'AccessToken', 'RefreshToken', 'AuthorizationCode')
       AND payload->>'accountId' = ANY($1::text[])`,
    [userIds],
  );
  await db.query(
    `UPDATE users SET account_sessions_ended_at = now()
     WHERE id::text = ANY($1::text[]) AND id IS DISTINCT FROM $2::uuid`,
    [userIds, keepAccountPagesOf ?? null],
  );
}
