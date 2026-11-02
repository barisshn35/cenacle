// SPDX-License-Identifier: AGPL-3.0-only
// Per-account limits of failed sign-in attempts (password, second step).
import type pg from 'pg';

export type AttemptKind = 'password' | 'second_step';

/** An attempt taken before its guess is checked. */
export type Attempt = { allowed: true; id: string } | { allowed: false };

/**
 * Records an attempt of an account before its guess is checked, unless the
 * account already has `limit` in the window: one account's attempts are
 * counted one at a time (an advisory lock for the few statements), so no
 * more than `limit` are ever checked, whatever arrives in parallel. An
 * allowed attempt counts as a failure until forgetAttempt (a correct guess).
 */
export async function takeAttempt(
  pool: pg.Pool,
  userId: string,
  kind: AttemptKind,
  limit: number,
  windowSeconds: number,
): Promise<Attempt> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `signin_attempts:${userId}:${kind}`,
    ]);
    await client.query(
      `DELETE FROM signin_attempts
       WHERE user_id = $1 AND kind = $2 AND at <= now() - make_interval(secs => $3)`,
      [userId, kind, windowSeconds],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO signin_attempts (user_id, kind)
       SELECT $1, $2 WHERE (SELECT count(*) FROM signin_attempts
                            WHERE user_id = $1 AND kind = $2
                              AND at > now() - make_interval(secs => $3)) < $4
       RETURNING id`,
      [userId, kind, windowSeconds, limit],
    );
    await client.query('COMMIT');
    return rows[0] ? { allowed: true, id: rows[0].id } : { allowed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The attempt succeeded (or was never decided): it does not count. */
export async function forgetAttempt(pool: pg.Pool, attempt: Attempt): Promise<void> {
  if (attempt.allowed) await pool.query('DELETE FROM signin_attempts WHERE id = $1', [attempt.id]);
}
