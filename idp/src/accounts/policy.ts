// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';

/** The organization's sign-in policy (v0.29). */
export interface SignInPolicy {
  /** Everyone signing in with a password needs a code from an authenticator app. */
  requireTwoStep: boolean;
  /** People may add and sign in with passkeys. */
  passkeys: boolean;
}

/** The secure default: two-step verification required, passkeys off. */
export const DEFAULT_POLICY: SignInPolicy = { requireTwoStep: true, passkeys: false };

export class PolicyStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<SignInPolicy> {
    const { rows } = await this.pool.query<{ require_two_step: boolean; passkeys: boolean }>(
      'SELECT require_two_step, passkeys FROM sign_in_policy',
    );
    const row = rows[0];
    return row ? { requireTwoStep: row.require_two_step, passkeys: row.passkeys } : DEFAULT_POLICY;
  }

  async set(policy: SignInPolicy): Promise<void> {
    await this.pool.query(
      `INSERT INTO sign_in_policy (id, require_two_step, passkeys, updated_at)
       VALUES (true, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET require_two_step = $1, passkeys = $2, updated_at = now()`,
      [policy.requireTwoStep, policy.passkeys],
    );
  }
}
