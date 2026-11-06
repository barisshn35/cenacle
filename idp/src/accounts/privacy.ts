// SPDX-License-Identifier: AGPL-3.0-only
// Data subject requests (GDPR, KVKK) in Cenacle ID: what it keeps about a
// person as one file, and deleting an account. The chat answers for its own
// data (server/internal/chat/privacy.go).
import type pg from 'pg';
import { endSessions } from '../directory/store.ts';

/** One line of a data export, as in the chat's: {"kind": …, "data": …}. */
export interface ExportItem {
  kind: string;
  data: Record<string, unknown>;
}

/** The export as NDJSON, one item per line. */
export function toNdjson(items: ExportItem[]): string {
  return items.map((i) => `${JSON.stringify(i)}\n`).join('');
}

/** What an export is sent as. */
export const EXPORT_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'content-disposition': 'attachment; filename="cenacle-id-data.ndjson"',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const seconds = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;

/**
 * Everything Cenacle ID keeps about an account, without its secrets: no
 * password hash, two-step secret or recovery codes (only whether they are
 * set), no passkey keys. Null for an unknown account.
 */
export async function exportAccount(pool: pg.Pool, id: string): Promise<ExportItem[] | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.email_verified, u.display_name, u.username, u.title, u.locale,
            u.created_at, u.updated_at, u.disabled_at, u.admin_disabled_at, u.directory_role,
            u.is_admin, u.external_id, u.synced_at, u.scim_managed, u.scim_user_name,
            u.scim_external_id, u.sessions_ended_at, u.password_hash IS NOT NULL AS password_set,
            u.totp_enabled_at, s.kind AS source_kind, s.name AS source_name
     FROM users u LEFT JOIN identity_sources s ON s.id = u.source_id WHERE u.id = $1`,
    [id],
  );
  const u = rows[0];
  if (!u) return null;
  const items: ExportItem[] = [
    {
      kind: 'account',
      data: {
        id: u.id,
        email: u.email,
        email_verified: u.email_verified,
        display_name: u.display_name,
        username: u.username,
        title: u.title,
        locale: u.locale,
        created_at: u.created_at,
        updated_at: u.updated_at,
        // Turned off by the directory or SCIM, or by an administrator.
        disabled_at: u.disabled_at,
        disabled_by_administrator_at: u.admin_disabled_at,
        directory_role: u.directory_role,
        administrator: u.is_admin,
        source: u.source_kind ? { kind: u.source_kind, name: u.source_name } : null,
        external_id: u.external_id,
        synced_at: u.synced_at,
        scim: u.scim_managed
          ? { user_name: u.scim_user_name, external_id: u.scim_external_id }
          : null,
        sessions_ended_at: u.sessions_ended_at,
        password_set: u.password_set,
        two_step: { enabled: u.totp_enabled_at !== null, enabled_at: u.totp_enabled_at },
      },
    },
  ];
  const photos = await pool.query<{
    origin: string;
    content_type: string;
    data: Buffer;
    updated_at: Date;
  }>(
    'SELECT origin, content_type, data, updated_at FROM user_photos WHERE user_id = $1 ORDER BY origin',
    [id],
  );
  for (const p of photos.rows) {
    items.push({
      kind: 'photo',
      data: {
        origin: p.origin,
        content_type: p.content_type,
        updated_at: p.updated_at,
        base64: p.data.toString('base64'),
      },
    });
  }
  const groups = await pool.query<{ name: string; source: string; kind: string }>(
    `SELECT g.name, s.name AS source, s.kind FROM user_groups ug
     JOIN directory_groups g ON g.id = ug.group_id JOIN identity_sources s ON s.id = g.source_id
     WHERE ug.user_id = $1 ORDER BY s.name, g.name`,
    [id],
  );
  for (const g of groups.rows) {
    items.push({ kind: 'group', data: { name: g.name, source: g.source, source_kind: g.kind } });
  }
  const passkeys = await pool.query<{
    name: string;
    device_type: string;
    backed_up: boolean;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT name, device_type, backed_up, created_at, last_used_at FROM passkeys
     WHERE user_id = $1 ORDER BY created_at`,
    [id],
  );
  for (const p of passkeys.rows) items.push({ kind: 'passkey', data: { ...p } });
  const codes = await pool.query<{ unused: string; used: string }>(
    `SELECT count(*) FILTER (WHERE used_at IS NULL) AS unused,
            count(*) FILTER (WHERE used_at IS NOT NULL) AS used
     FROM recovery_codes WHERE user_id = $1`,
    [id],
  );
  items.push({
    kind: 'recovery_codes',
    data: { unused: Number(codes.rows[0]!.unused), used: Number(codes.rows[0]!.used) },
  });
  // Failed attempts still counted against the account's sign-in limit.
  const attempts = await pool.query<{ at: Date; kind: string }>(
    'SELECT at, kind FROM signin_attempts WHERE user_id = $1 ORDER BY at',
    [id],
  );
  for (const a of attempts.rows) items.push({ kind: 'signin_attempt', data: { ...a } });
  // Signed-in sessions of Cenacle ID and what apps were allowed (no tokens).
  const payloads = await pool.query<{
    model: string;
    payload: Record<string, unknown>;
    expires_at: Date | null;
  }>(
    `SELECT model, payload, expires_at FROM oidc_payloads
     WHERE model IN ('Session', 'Grant') AND payload->>'accountId' = $1 ORDER BY model, id`,
    [id],
  );
  for (const p of payloads.rows) {
    items.push(
      p.model === 'Session'
        ? {
            kind: 'session',
            data: { signed_in_at: seconds(p.payload.loginTs), expires_at: p.expires_at },
          }
        : {
            kind: 'app_grant',
            data: {
              client_id: p.payload.clientId ?? null,
              granted_at: seconds(p.payload.iat),
              expires_at: p.expires_at,
            },
          },
    );
  }
  const events = await pool.query<{
    at: Date;
    action: string;
    ip: string;
    detail: Record<string, unknown>;
  }>('SELECT at, action, ip, detail FROM audit_events WHERE user_id = $1 ORDER BY at, id', [id]);
  for (const e of events.rows) items.push({ kind: 'audit', data: { ...e } });
  return items;
}

/**
 * Keys of an audit event's detail that say nothing about the person who
 * acted (which account, directory or provider they acted on, how they signed
 * in); a deleted account's own events keep only these.
 */
const NEUTRAL_DETAIL = [
  'account',
  'user',
  'source',
  'provider',
  'kind',
  'where',
  'method',
  'second_step',
  'require_two_step',
  'passkeys',
];

/**
 * Deletes an account: ends its sessions (in the apps too, through the
 * directory feed), removes it with everything that belongs to it (photos,
 * groups, passkeys, recovery codes, sign-in attempts, challenges), its
 * oidc-provider records, and the address and IP of its own audit events
 * (the events stay, without the account). A tombstone (deleted_accounts)
 * lets the directory feed report it. False if there is no such account.
 */
export async function deleteAccount(pool: pg.Pool, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ email: string | null; username: string | null }>(
      'SELECT email::text, username::text FROM users WHERE id = $1 FOR UPDATE',
      [id],
    );
    const user = rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return false;
    }
    await endSessions(client, [id]);
    // Interactions, codes and anything else oidc-provider kept for it.
    await client.query(`DELETE FROM oidc_payloads WHERE payload->>'accountId' = $1`, [id]);
    await client.query(
      `UPDATE audit_events SET ip = '', detail = coalesce(
         (SELECT jsonb_object_agg(k, v) FROM jsonb_each(detail) AS e(k, v) WHERE k = ANY($2::text[])),
         '{}')
       WHERE user_id = $1`,
      [id, NEUTRAL_DETAIL],
    );
    // Failed sign-ins for no account, or another one, may still carry the
    // address or sign-in name typed: it goes, the rest of the event stays.
    const names = [user.email, user.username].filter((n): n is string => Boolean(n));
    if (names.length > 0) {
      await client.query(
        `UPDATE audit_events SET detail = detail - 'email'
         WHERE user_id IS DISTINCT FROM $1 AND lower(detail->>'email') = ANY($2::text[])`,
        [id, names.map((n) => n.toLowerCase())],
      );
    }
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('INSERT INTO deleted_accounts (id) VALUES ($1) ON CONFLICT DO NOTHING', [
      id,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
