// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  hashPassword,
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
  disabled: boolean;
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
  password_hash: string | null;
  username: string | null;
  title: string | null;
  directory_role: 'admin' | 'guest' | null;
  is_admin: boolean;
  source_id: string | null;
  source_kind: 'ldap' | 'oidc' | 'saml' | null;
}

const COLUMNS =
  'id, email, email_verified, display_name, locale, updated_at, disabled_at, password_hash, username, title, directory_role, is_admin, source_id, ' +
  '(SELECT kind FROM identity_sources WHERE identity_sources.id = source_id) AS source_kind';

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    emailVerified: r.email_verified,
    displayName: r.display_name,
    locale: r.locale,
    updatedAt: r.updated_at,
    disabled: r.disabled_at !== null,
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
    if (!ok || row.disabled_at !== null) return null;
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
   * Disables or enables an account by id: local accounts and those of identity
   * providers (directories manage their own).
   */
  async setDisabledById(id: string, disabled: boolean): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
       WHERE id = $1 AND (source_id IS NULL
         OR source_id IN (SELECT id FROM identity_sources WHERE kind <> 'ldap'))`,
      [id, disabled],
    );
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

  /** The groups an account is in (directory groups), by name. */
  async groups(id: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ name: string }>(
      `SELECT g.name FROM user_groups ug JOIN directory_groups g ON g.id = ug.group_id
       WHERE ug.user_id = $1 ORDER BY g.name`,
      [id],
    );
    return rows.map((r) => r.name);
  }

  async setDisabled(email: string, disabled: boolean): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
       WHERE email = $1`,
      [email.trim(), disabled],
    );
    if (rowCount === 0) throw new UserError('not_found');
  }
}
