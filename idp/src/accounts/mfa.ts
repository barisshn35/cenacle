// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import type pg from 'pg';
import { openPrivateKey, sealPrivateKey } from '../keys/crypto.ts';
import { forgetAttempt, takeAttempt as takeAccountAttempt, type Attempt } from './attempts.ts';

/** Codes from the clock step before and after the current one are accepted (30 s each way). */
const TOLERANCE_SECONDS = 30;
/** TOTP period (the authenticator apps' default). */
const PERIOD_SECONDS = 30;
/** How many recovery codes a user gets. */
export const RECOVERY_CODE_COUNT = 10;
/** A second step must follow the password within this time, with at most this many tries. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;
export const CHALLENGE_ATTEMPTS = 5;
/** Across challenges: an account allows this many failed second steps per window. */
export const ACCOUNT_FAILURES = 10;
export const ACCOUNT_FAILURE_WINDOW_SECONDS = 15 * 60;

export type Purpose = 'login' | 'account';
export type SecondFactor = 'totp' | 'recovery';

export interface Challenge {
  id: string;
  userId: string;
  purpose: Purpose;
  attemptsLeft: number;
  /** The account's attempt taken with it (takeAttempt): a failure until passed. */
  attempt?: Attempt;
}

/** Recovery codes look like "k7f3m-2qx9a": lower case, no look-alike characters. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** What the user typed, without spaces, dashes and case. */
function normalizeRecovery(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

function hashRecovery(code: string): Buffer {
  return createHash('sha256').update(normalizeRecovery(code)).digest();
}

const aad = (userId: string) => `totp:${userId}`;

/**
 * Two-step verification: TOTP (RFC 6238, 6 digits, 30 s) with replay
 * protection, one-time recovery codes, and the challenges that connect a
 * password check to the second step.
 */
export class MfaStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly kek: Buffer,
    private readonly issuerName = 'Cenacle ID',
  ) {}

  async enabled(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ on: boolean }>(
      'SELECT totp_enabled_at IS NOT NULL AS on FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.on ?? false;
  }

  /** Starts a setup (replacing an unconfirmed one): returns the secret and its otpauth URI. */
  async beginSetup(userId: string, label: string): Promise<{ secret: string; uri: string }> {
    const secret = generateSecret();
    const { rowCount } = await this.pool.query(
      `UPDATE users SET totp_secret_enc = $2, totp_last_step = NULL
       WHERE id = $1 AND totp_enabled_at IS NULL`,
      [userId, sealPrivateKey(this.kek, aad(userId), secret)],
    );
    if (rowCount === 0) throw new Error('two-step verification is already on');
    return { secret, uri: generateURI({ issuer: this.issuerName, label, secret }) };
  }

  /** The secret of an unconfirmed setup (to show it again), or null. */
  async pendingSecret(
    userId: string,
    label: string,
  ): Promise<{ secret: string; uri: string } | null> {
    const secret = await this.secret(userId, false);
    return secret ? { secret, uri: generateURI({ issuer: this.issuerName, label, secret }) } : null;
  }

  /**
   * Confirms a setup with a code from the app. Returns the recovery codes
   * (shown once), or null when the code does not match.
   */
  async confirmSetup(userId: string, code: string): Promise<string[] | null> {
    const secret = await this.secret(userId, false);
    if (!secret || !(await this.checkTotp(userId, secret, code))) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET totp_enabled_at = now(), updated_at = now() WHERE id = $1',
        [userId],
      );
      const codes = await this.replaceRecoveryCodes(client, userId);
      await client.query('COMMIT');
      return codes;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Checks a TOTP code or an unused recovery code (which is then used up). */
  async verify(userId: string, code: string): Promise<SecondFactor | null> {
    const trimmed = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(trimmed)) {
      const secret = await this.secret(userId, true);
      return secret && (await this.checkTotp(userId, secret, trimmed)) ? 'totp' : null;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE recovery_codes SET used_at = now()
       WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, hashRecovery(trimmed)],
    );
    return rowCount === 1 ? 'recovery' : null;
  }

  async remainingRecoveryCodes(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [userId],
    );
    return rows[0]!.n;
  }

  /** New recovery codes; the old ones stop working. */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const codes = await this.replaceRecoveryCodes(client, userId);
      await client.query('COMMIT');
      return codes;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async disable(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
         updated_at = now() WHERE id = $1`,
      [userId],
    );
    await this.pool.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
  }

  // --- challenges -----------------------------------------------------------

  /** A second step for a passed password check; `id` binds it (interaction uid or random). */
  async createChallenge(
    userId: string,
    purpose: Purpose,
    id = randomBytes(24).toString('base64url'),
  ) {
    await this.pool.query('DELETE FROM mfa_challenges WHERE expires_at < now()');
    await this.pool.query(
      `INSERT INTO mfa_challenges (id, user_id, purpose, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, purpose = EXCLUDED.purpose,
         -- Entering the password again does not bring the attempts back.
         attempts = CASE WHEN mfa_challenges.expires_at > now() AND mfa_challenges.user_id = EXCLUDED.user_id
                         THEN mfa_challenges.attempts ELSE 0 END,
         expires_at = CASE WHEN mfa_challenges.expires_at > now() AND mfa_challenges.user_id = EXCLUDED.user_id
                           THEN mfa_challenges.expires_at ELSE EXCLUDED.expires_at END`,
      [id, userId, purpose, CHALLENGE_TTL_SECONDS],
    );
    return id;
  }

  async challenge(id: string, purpose: Purpose): Promise<Challenge | null> {
    const { rows } = await this.pool.query<{ user_id: string; attempts: number }>(
      `SELECT user_id, attempts FROM mfa_challenges
       WHERE id = $1 AND purpose = $2 AND expires_at > now() AND attempts < $3`,
      [id, purpose, CHALLENGE_ATTEMPTS],
    );
    const row = rows[0];
    return row
      ? { id, userId: row.user_id, purpose, attemptsLeft: CHALLENGE_ATTEMPTS - row.attempts }
      : null;
  }

  /**
   * Takes one attempt of a live challenge, and one of the account, before the
   * code is checked, so parallel requests cannot exceed either limit. Returns
   * the user and the attempts left after this one, or null when the challenge
   * is spent, expired, or the account had too many failures lately. A code
   * that passes is reported with passed().
   */
  async takeAttempt(id: string, purpose: Purpose): Promise<Challenge | null> {
    const { rows } = await this.pool.query<{ user_id: string; attempts: number }>(
      `UPDATE mfa_challenges SET attempts = attempts + 1
       WHERE id = $1 AND purpose = $2 AND expires_at > now() AND attempts < $3
       RETURNING user_id, attempts`,
      [id, purpose, CHALLENGE_ATTEMPTS],
    );
    const row = rows[0];
    if (!row) return null;
    const attempt = await takeAccountAttempt(
      this.pool,
      row.user_id,
      'second_step',
      ACCOUNT_FAILURES,
      ACCOUNT_FAILURE_WINDOW_SECONDS,
    );
    if (!attempt.allowed) return null;
    return {
      id,
      userId: row.user_id,
      purpose,
      attemptsLeft: CHALLENGE_ATTEMPTS - row.attempts,
      attempt,
    };
  }

  /** The code of a taken attempt passed: it is no failure of the account. */
  async passed(challenge: Challenge): Promise<void> {
    if (challenge.attempt) await forgetAttempt(this.pool, challenge.attempt);
  }

  /**
   * Marks the sign-in's challenge as passed by a confirmed setup (a code was
   * entered). Only such a challenge lets the sign-in finish after a setup.
   */
  async confirmSetupChallenge(id: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE mfa_challenges SET purpose = 'setup_confirmed', attempts = 0
       WHERE id = $1 AND user_id = $2 AND purpose = 'login' AND expires_at > now()`,
      [id, userId],
    );
  }

  /** Spends a confirmed setup's challenge once; returns its user, or null. */
  async takeConfirmedSetup(id: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `DELETE FROM mfa_challenges
       WHERE id = $1 AND purpose = 'setup_confirmed' AND expires_at > now()
       RETURNING user_id`,
      [id],
    );
    return rows[0]?.user_id ?? null;
  }

  async finishChallenge(id: string): Promise<void> {
    await this.pool.query('DELETE FROM mfa_challenges WHERE id = $1', [id]);
  }

  // --- internals ------------------------------------------------------------

  private async secret(userId: string, confirmed: boolean): Promise<string | null> {
    const { rows } = await this.pool.query<{ totp_secret_enc: Buffer | null; on: boolean }>(
      'SELECT totp_secret_enc, totp_enabled_at IS NOT NULL AS on FROM users WHERE id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row?.totp_secret_enc || row.on !== confirmed) return null;
    return openPrivateKey(this.kek, aad(userId), row.totp_secret_enc);
  }

  /** A valid code from a time step after the last accepted one (each code works once). */
  private async checkTotp(userId: string, secret: string, code: string): Promise<boolean> {
    const epoch = Math.floor(Date.now() / 1000);
    const result = await verify({ secret, token: code, epoch, epochTolerance: TOLERANCE_SECONDS });
    if (!result.valid) return false;
    // The step the code belongs to (delta: periods before or after now).
    const step = Math.floor(epoch / PERIOD_SECONDS) + result.delta;
    const { rowCount } = await this.pool.query(
      `UPDATE users SET totp_last_step = $2
       WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [userId, step],
    );
    return rowCount === 1;
  }

  private async replaceRecoveryCodes(client: pg.PoolClient, userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    await client.query(
      `INSERT INTO recovery_codes (user_id, code_hash)
       SELECT $1, unnest($2::bytea[])`,
      [userId, codes.map(hashRecovery)],
    );
    return codes;
  }
}

/** Constant-time comparison of two strings (e.g. signed cookie MACs). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
