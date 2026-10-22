// SPDX-License-Identifier: Apache-2.0
// The account of a person an identity provider vouched for.
import type pg from 'pg';
import { endSessions, ensureGroups, upsertPerson, type Role } from '../directory/store.ts';
import type { Provider } from './store.ts';

export interface FederatedPerson {
  /** The provider's stable id of the person (OIDC sub, SAML NameID). */
  externalId: string;
  displayName: string;
  email: string | null;
  /** The provider vouches for the address (email_verified, or a trusted SAML provider). */
  emailVerified: boolean;
  groups: string[];
}

export type FederatedSignIn = { userId: string } | { error: 'disabled' };

/**
 * Creates or refreshes the account of a person signed in at a provider: name,
 * address, groups and role (from the admin and guest groups). An account an
 * administrator disabled stays disabled. With linkByEmail, a local account with
 * the same verified address becomes the provider's account.
 */
export async function signInFederated(
  pool: pg.Pool,
  provider: Provider,
  person: FederatedPerson,
): Promise<FederatedSignIn> {
  const externalId = person.externalId.slice(0, 500);
  const { rows: existing } = await pool.query<{ disabled: boolean }>(
    `SELECT disabled_at IS NOT NULL AS disabled FROM users WHERE source_id = $1 AND external_id = $2`,
    [provider.id, externalId],
  );
  if (existing[0]?.disabled) return { error: 'disabled' };

  let email = person.email && person.emailVerified ? person.email.slice(0, 320) : null;
  if (email && !provider.config.linkByEmail) {
    // The address belongs to another account: this one goes without it.
    const { rowCount } = await pool.query(
      `SELECT 1 FROM users WHERE email = $1::citext
         AND (source_id IS DISTINCT FROM $2 OR external_id IS DISTINCT FROM $3)`,
      [email, provider.id, externalId],
    );
    if (rowCount) email = null;
  }
  if (email) {
    // A disabled local account is not revived by linking it.
    const { rowCount } = await pool.query(
      `SELECT 1 FROM users WHERE email = $1::citext AND source_id IS NULL AND disabled_at IS NOT NULL`,
      [email],
    );
    if (rowCount) return { error: 'disabled' };
  }

  const groups = [...new Set(person.groups.map((g) => g.slice(0, 200)).filter(Boolean))].slice(
    0,
    500,
  );
  const inAny = (wanted: string[]) => wanted.some((g) => groups.includes(g));
  const role: Role = inAny(provider.config.adminGroups)
    ? 'admin'
    : inAny(provider.config.guestGroups)
      ? 'guest'
      : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupIds = await ensureGroups(
      client,
      provider.id,
      groups.map((name) => ({ externalId: name, name, dn: '' })),
    );
    const { id } = await upsertPerson(
      client,
      provider.id,
      {
        dn: '',
        externalId,
        // Sign-in names belong to directories; provider accounts sign in there.
        username: null,
        displayName: (person.displayName || email || externalId).slice(0, 200),
        email,
        title: null,
        photo: null,
        uid: '',
      },
      role,
      groupIds,
    );
    await client.query('COMMIT');
    return { userId: id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Ends the Cenacle ID sessions of a provider's people (the provider was turned off). */
export async function endProviderSessions(pool: pg.Pool, providerId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE source_id = $1', [
    providerId,
  ]);
  if (rows.length > 0)
    await endSessions(
      pool,
      rows.map((r) => r.id),
    );
}
