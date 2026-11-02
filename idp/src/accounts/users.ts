// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';
import { APP_GROUPS_SQL } from '../directory/store.ts';
import { forgetAttempt, takeAttempt, type Attempt } from './attempts.ts';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './passwords.ts';

export interface User {
  id: string;
  /** Directory accounts may have no address. */
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  locale: string | null;
  updatedAt: Date;
  /** Signs in nowhere: an administrator or the account's source turned it off. */
  disabled: boolean;
  /** Disabled by an administrator (no directory or SCIM undoes it). */
  adminDisabled: boolean;
  /** A directory or SCIM manages whether the account is active. */
  sourceManaged: boolean;
  /** Account-page cookies issued until then no longer sign in (endSessions). */
  accountSessionsEndedAt: Date | null;
  /** The sign-in name of a directory account. */
  username: string | null;
  title: string | null;
  /** From a directory's admin and guest filters. */
  directoryRole: 'admin' | 'guest' | null;
  /** Administers Cenacle ID (the admin panel). */
  isAdmin: boolean;
  /** Comes from a directory (LDAP): name, address and state are the directory's. */
  fromDirectory: boolean;
  /** Signs in at another identity provider (OIDC, SAML). */
  fromProvider: boolean;
}

interface UserRow {
  id: string;
  email: string | null;
  email_verified: boolean;
  display_name: string;
  locale: string | null;
  updated_at: Date;
  disabled_at: Date | null;
  admin_disabled_at: Date | null;
  scim_managed: boolean;
  account_sessions_ended_at: Date | null;
  password_hash: string | null;
  username: string | null;
  title: string | null;
  directory_role: 'admin' | 'guest' | null;
  is_admin: boolean;
  source_id: string | null;
  source_kind: 'ldap' | 'oidc' | 'saml' | null;
}

const COLUMNS =
  'id, email, email_verified, display_name, locale, updated_at, disabled_at, admin_disabled_at, scim_managed, account_sessions_ended_at, password_hash, username, title, directory_role, is_admin, source_id, ' +
  '(SELECT kind FROM identity_sources WHERE identity_sources.id = source_id) AS source_kind';

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    emailVerified: r.email_verified,
    displayName: r.display_name,
    locale: r.locale,
    updatedAt: r.updated_at,
    disabled: r.disabled_at !== null || r.admin_disabled_at !== null,
    adminDisabled: r.admin_disabled_at !== null,
    sourceManaged: r.source_kind === 'ldap' || r.scim_managed,
    accountSessionsEndedAt: r.account_sessions_ended_at,
    username: r.username,
    title: r.title,
    directoryRole: r.directory_role,
    isAdmin: r.is_admin,
    fromDirectory: r.source_kind === 'ldap',
    fromProvider: r.source_kind === 'oidc' || r.source_kind === 'saml',
  };
}

export class UserError extends Error {
  constructor(
    readonly code:
      'email_taken' | 'invalid_email' | 'invalid_name' | 'too_short' | 'too_long' | 'not_found',
  ) {
    super(code);
    this.name = 'UserError';
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** An administrator's disable ($2 true) or enable ($2 false) of the accounts the WHERE clause names. */
const SET_DISABLED = `UPDATE users SET
    admin_disabled_at = CASE WHEN $2 THEN coalesce(admin_disabled_at, now()) ELSE NULL END,
    disabled_at = CASE WHEN $2 OR scim_managed
                         OR source_id IN (SELECT id FROM identity_sources WHERE kind = 'ldap')
                       THEN disabled_at ELSE NULL END,
    updated_at = now()`;

export class UserStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: {
    email: string;
    displayName: string;
    password: string;
    emailVerified?: boolean;
    locale?: string;
  }): Promise<User> {
    const email = input.email.trim();
    const displayName = input.displayName.trim();
    if (!EMAIL.test(email) || email.length > 320) throw new UserError('invalid_email');
    if (displayName.length < 1 || displayName.length > 200) throw new UserError('invalid_name');
    const problem = checkPasswordPolicy(input.password);
    if (problem) throw new UserError(problem);
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO users (email, display_name, password_hash, email_verified, locale)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [
          email,
          displayName,
          await hashPassword(input.password),
          input.emailVerified ?? false,
          input.locale ?? null,
        ],
      );
      return toUser(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new UserError('email_taken');
      throw err;
    }
  }

  async findById(id: string): Promise<User | null> {
    // Only well-formed ids reach the database (sub values come from tokens).
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  /**
   * Takes a password attempt of the account an identifier (an e-mail address
   * or a directory sign-in name) names, before the password is checked: at
   * most `limit` per window (attempts.ts). Null for an unknown identifier.
   */
  async passwordAttempt(
    identifier: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ id: string; attempt: Attempt } | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT u.id FROM users u WHERE u.email = $1 OR u.username = $1
       ORDER BY (u.email = $1) DESC NULLS LAST LIMIT 1`,
      [identifier.trim()],
    );
    const id = rows[0]?.id;
    if (!id) return null;
    return { id, attempt: await takeAttempt(this.pool, id, 'password', limit, windowSeconds) };
  }

  /** A password attempt that succeeded (or was never decided) does not count. */
  async forgetAttempt(attempt: Attempt): Promise<void> {
    await forgetAttempt(this.pool, attempt);
  }

  /**
   * Checks e-mail and password. Returns null for unknown accounts, wrong
   * passwords, disabled accounts and accounts without a password alike, and
   * spends the same time on each, so callers cannot tell which one it was.
   */
  async authenticate(email: string, password: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE email = $1`,
      [email.trim()],
    );
    const row = rows[0];
    if (!row?.password_hash) {
      await burnPasswordCheck(password);
      return null;
    }
    const ok = await verifyPassword(row.password_hash, password);
    if (!ok || toUser(row).disabled) return null;
    if (needsRehash(row.password_hash)) {
      // Switching to or from FIPS mode: the password moves to this mode's hash.
      await this.pool.query(
        `UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash = $3`,
        [row.id, await hashPassword(password), row.password_hash],
      );
    }
    return toUser(row);
  }

  async setPassword(email: string, password: string): Promise<void> {
    const problem = checkPasswordPolicy(password);
    if (problem) throw new UserError(problem);
    const { rowCount } = await this.pool.query(
      `UPDATE users SET password_hash = $2, updated_at = now() WHERE email = $1`,
      [email.trim(), await hashPassword(password)],
    );
    if (rowCount === 0) throw new UserError('not_found');
  }

  /**
   * Accounts for the admin panel: by name, address or username, ordered by
   * id, a page at a time (after: the last id of the previous page).
   */
  async search(query: string, after: string | undefined, limit: number) {
    const pattern = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await this.pool.query<UserRow & { two_step: boolean }>(
      `SELECT ${COLUMNS}, totp_enabled_at IS NOT NULL AS two_step FROM users
       WHERE ($1 = '%%' OR display_name ILIKE $1 OR email ILIKE $1 OR username ILIKE $1)
         AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id LIMIT $3`,
      [pattern, after && /^[0-9a-f-]{36}$/i.test(after) ? after : null, limit],
    );
    return rows.map((r) => ({ ...toUser(r), twoStep: r.two_step }));
  }

  /**
   * Disables or enables an account by id, as an administrator: no directory
   * sync or sign-in and no SCIM push undoes it. Enabling takes back only the
   * administrator's disable; whether a directory or SCIM keeps the account
   * active stays theirs (accounts no source manages any more are enabled).
   */
  async setDisabledById(id: string, disabled: boolean): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const { rowCount } = await this.pool.query(`${SET_DISABLED} WHERE id = $1`, [id, disabled]);
    return rowCount === 1;
  }

  /** Changes the name of a local account (directories and providers own theirs). */
  async setDisplayName(id: string, name: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET display_name = $2, updated_at = now()
       WHERE id = $1 AND source_id IS NULL AND display_name IS DISTINCT FROM $2`,
      [id, name],
    );
    return rowCount === 1;
  }

  async setAdminById(id: string, admin: boolean): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1`,
      [id, admin],
    );
    return rowCount === 1;
  }

  /** Gives or takes the administration of Cenacle ID. */
  async setAdmin(email: string, admin: boolean): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET is_admin = $2, updated_at = now() WHERE email = $1`,
      [email.trim(), admin],
    );
    if (rowCount === 0) throw new UserError('not_found');
  }

  /** The groups an account is in, as apps see them (APP_GROUPS_SQL). */
  async groups(id: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ n: string }>(`${APP_GROUPS_SQL} ORDER BY n`, [id]);
    return rows.map((r) => r.n);
  }

  /**
   * Disables or enables an account by e-mail address (the CLI), like
   * setDisabledById. Returns the account and whether it is disabled now (by
   * its directory or SCIM, after an enable).
   */
  async setDisabled(email: string, disabled: boolean): Promise<{ id: string; disabled: boolean }> {
    const { rows } = await this.pool.query<{ id: string; disabled: boolean }>(
      `${SET_DISABLED} WHERE email = $1
       RETURNING id, (disabled_at IS NOT NULL OR admin_disabled_at IS NOT NULL) AS disabled`,
      [email.trim(), disabled],
    );
    if (!rows[0]) throw new UserError('not_found');
    return rows[0];
  }
}
