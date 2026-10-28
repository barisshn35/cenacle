// SPDX-License-Identifier: AGPL-3.0-only
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
  if (existing[0] && provider.scimSince) {
    // Signed in under the id SCIM gave it: the account is bound now.
    await pool.query(
      `UPDATE users SET scim_pending_bind = false
       WHERE source_id = $1 AND external_id = $2 AND scim_pending_bind`,
      [provider.id, externalId],
    );
  }
  if (!existing[0] && provider.scimSince && person.email && person.emailVerified) {
    // Provisioned over SCIM under another id (its userName or own id): the
    // first sign-in binds the account to the provider's id of the person.
    // Only once: an account bound to someone is never handed to another id.
    const { rows: provisioned } = await pool.query<{ disabled: boolean }>(
      `UPDATE users SET external_id = $2, scim_pending_bind = false
       WHERE id = (SELECT id FROM users WHERE source_id = $1 AND scim_managed AND scim_pending_bind
                     AND (email = $3::citext OR lower(scim_user_name) = lower($3)) LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM users WHERE source_id = $1 AND external_id = $2)
       RETURNING disabled_at IS NOT NULL AS disabled`,
      [provider.id, externalId, person.email.slice(0, 320)],
    );
    if (provisioned[0]?.disabled) return { error: 'disabled' };
  }

  let email = person.email && person.emailVerified ? person.email.slice(0, 320) : null;
  const link = provider.config.linkByEmail;
  if (email && link) {
    // A disabled local account is not revived by linking it.
    const { rowCount } = await pool.query(
      `SELECT 1 FROM users WHERE email = $1::citext AND source_id IS NULL AND disabled_at IS NOT NULL`,
      [email],
    );
    if (rowCount) return { error: 'disabled' };
  }
  if (email) {
    // The address belongs to another account (one not linked by it, see
    // upsertPerson): this one goes without it.
    const { rowCount } = await pool.query(
      `SELECT 1 FROM users WHERE email = $1::citext
         AND (source_id IS DISTINCT FROM $2 OR external_id IS DISTINCT FROM $3)
         AND NOT ($4 AND source_id IS NULL AND NOT is_admin AND totp_enabled_at IS NULL)`,
      // Only a person without an account here yet links one.
      [email, provider.id, externalId, link && !existing[0]],
    );
    if (rowCount) email = null;
  }

  const groups = [...new Set(person.groups.map((g) => g.slice(0, 200)).filter(Boolean))].slice(
    0,
    500,
  );
  // With SCIM the provider pushes groups; sign-ins keep them as they are.
  const scim = provider.scimSince !== null;
  if (scim) {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT g.name FROM users u JOIN user_groups ug ON ug.user_id = u.id
       JOIN directory_groups g ON g.id = ug.group_id WHERE u.source_id = $1 AND u.external_id = $2`,
      [provider.id, externalId],
    );
    groups.splice(0, groups.length, ...rows.map((r) => r.name));
  }
  const inAny = (wanted: string[]) => wanted.some((g) => groups.includes(g));
  const role: Role = inAny(provider.config.adminGroups)
    ? 'admin'
    : inAny(provider.config.guestGroups)
      ? 'guest'
      : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupIds = scim
      ? null
      : await ensureGroups(
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
      provider.config.linkByEmail,
      // Its sign-ins skip the second step: an administrator or an account with
      // one is never taken over by an address alone.
      false,
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
