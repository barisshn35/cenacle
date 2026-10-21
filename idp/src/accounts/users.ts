// SPDX-License-Identifier: Apache-2.0
import type pg from 'pg';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from './passwords.ts';

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  locale: string | null;
  updatedAt: Date;
  disabled: boolean;
}

interface UserRow {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string;
  locale: string | null;
  updated_at: Date;
  disabled_at: Date | null;
  password_hash: string | null;
}

const COLUMNS =
  'id, email, email_verified, display_name, locale, updated_at, disabled_at, password_hash';

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    emailVerified: r.email_verified,
    displayName: r.display_name,
    locale: r.locale,
    updatedAt: r.updated_at,
    disabled: r.disabled_at !== null,
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

  async setDisabled(email: string, disabled: boolean): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
       WHERE email = $1`,
      [email.trim(), disabled],
    );
    if (rowCount === 0) throw new UserError('not_found');
  }
}
