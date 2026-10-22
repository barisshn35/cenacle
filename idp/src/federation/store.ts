// SPDX-License-Identifier: Apache-2.0
// Identity providers (identity sources of kind oidc and saml) and the
// sign-ins at them that are on their way.
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { openPrivateKey, sealPrivateKey } from '../keys/crypto.ts';
import {
  oidcConfigSchema,
  samlConfigSchema,
  type OidcConfig,
  type ProviderKind,
  type SamlConfig,
} from './config.ts';

export type Provider =
  | {
      id: string;
      kind: 'oidc';
      name: string;
      config: OidcConfig;
      enabled: boolean;
      hasSecret: boolean;
    }
  | {
      id: string;
      kind: 'saml';
      name: string;
      config: SamlConfig;
      enabled: boolean;
      hasSecret: boolean;
    };

interface Row {
  id: string;
  kind: ProviderKind;
  name: string;
  config: unknown;
  secret_enc: Buffer | null;
  enabled: boolean;
}

function toProvider(r: Row): Provider {
  const base = { id: r.id, name: r.name, enabled: r.enabled, hasSecret: r.secret_enc !== null };
  return r.kind === 'oidc'
    ? { ...base, kind: 'oidc', config: oidcConfigSchema.parse(r.config) }
    : { ...base, kind: 'saml', config: samlConfigSchema.parse(r.config) };
}

const COLUMNS = 'id, kind, name, config, secret_enc, enabled';
/** A sign-in at another provider is finished within this time. */
const REQUEST_TTL_SECONDS = 600;

export type Purpose = 'login' | 'account';

export interface PendingRequest {
  state: string;
  sourceId: string;
  purpose: Purpose;
  interaction: string | null;
  nonce: string;
  codeVerifier: string;
  userId: string | null;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest();

export class ProviderStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly kek: Buffer,
  ) {}

  async list(): Promise<Provider[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM identity_sources WHERE kind IN ('oidc', 'saml') ORDER BY created_at`,
    );
    return rows.map(toProvider);
  }

  /** Providers shown on the sign-in pages. */
  async enabled(): Promise<{ id: string; name: string }[]> {
    return (await this.list()).filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name }));
  }

  async get(id: string): Promise<Provider | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM identity_sources WHERE id = $1 AND kind IN ('oidc', 'saml')`,
      [id],
    );
    return rows[0] ? toProvider(rows[0]) : null;
  }

  /** The OIDC client secret, decrypted (bound to the provider id). */
  async secret(id: string): Promise<string> {
    const { rows } = await this.pool.query<{ secret_enc: Buffer | null }>(
      'SELECT secret_enc FROM identity_sources WHERE id = $1',
      [id],
    );
    const sealed = rows[0]?.secret_enc;
    return sealed ? openPrivateKey(this.kek, `source:${id}`, sealed) : '';
  }

  async create(input: {
    kind: ProviderKind;
    name: string;
    config: OidcConfig | SamlConfig;
    enabled: boolean;
    secret: string;
  }): Promise<Provider> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO identity_sources (kind, name, config, enabled) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.kind, input.name, JSON.stringify(input.config), input.enabled],
    );
    const id = rows[0]!.id;
    if (input.secret) await this.setSecret(id, input.secret);
    return (await this.get(id))!;
  }

  /** Changes settings; a secret of undefined keeps the stored one. */
  async update(
    id: string,
    input: { name: string; config: OidcConfig | SamlConfig; enabled: boolean; secret?: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity_sources SET name = $2, config = $3, enabled = $4, updated_at = now()
       WHERE id = $1 AND kind IN ('oidc', 'saml')`,
      [id, input.name, JSON.stringify(input.config), input.enabled],
    );
    if (input.secret !== undefined) await this.setSecret(id, input.secret);
  }

  private async setSecret(id: string, secret: string) {
    await this.pool.query('UPDATE identity_sources SET secret_enc = $2 WHERE id = $1', [
      id,
      secret ? sealPrivateKey(this.kek, `source:${id}`, secret) : null,
    ]);
  }

  /** People who signed in with the provider. */
  async people(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM users WHERE source_id = $1',
      [id],
    );
    return rows[0]!.n;
  }

  // --- sign-ins on their way ------------------------------------------------

  /**
   * Starts a sign-in at a provider. Returns the request and the browser
   * binding (a random value for a cookie: only its hash is stored).
   */
  async begin(
    sourceId: string,
    purpose: Purpose,
    interaction: string | null,
  ): Promise<{ request: PendingRequest; binding: string }> {
    const binding = randomBytes(32).toString('base64url');
    const request: PendingRequest = {
      state: randomBytes(32).toString('base64url'),
      sourceId,
      purpose,
      interaction,
      nonce: randomBytes(32).toString('base64url'),
      codeVerifier: randomBytes(48).toString('base64url'),
      userId: null,
    };
    await this.pool.query('DELETE FROM federation_requests WHERE expires_at < now()');
    await this.pool.query(
      `INSERT INTO federation_requests
         (state, source_id, purpose, interaction, binding_hash, nonce, code_verifier, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
      [
        request.state,
        sourceId,
        purpose,
        interaction,
        sha256(binding),
        request.nonce,
        request.codeVerifier,
        REQUEST_TTL_SECONDS,
      ],
    );
    return { request, binding };
  }

  /** A live request of the provider that has no answer yet. */
  async pending(sourceId: string, state: string): Promise<PendingRequest | null> {
    if (!state) return null;
    const { rows } = await this.pool.query(
      `SELECT state, source_id, purpose, interaction, nonce, code_verifier, user_id
       FROM federation_requests
       WHERE state = $1 AND source_id = $2 AND user_id IS NULL AND expires_at > now()`,
      [state, sourceId],
    );
    const r = rows[0];
    return r
      ? {
          state: r.state,
          sourceId: r.source_id,
          purpose: r.purpose,
          interaction: r.interaction,
          nonce: r.nonce,
          codeVerifier: r.code_verifier,
          userId: r.user_id,
        }
      : null;
  }

  /** The provider vouched for this account (once per request). */
  async answer(state: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE federation_requests SET user_id = $2
       WHERE state = $1 AND user_id IS NULL AND expires_at > now()`,
      [state, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Takes an answered request in the browser that started it (the binding
   * cookie) and for where it is finished: the account it signs in, or null.
   */
  async finish(
    state: string,
    binding: string | undefined,
    purpose: Purpose,
    interaction: string | null,
  ): Promise<string | null> {
    if (!state || !binding) return null;
    const { rows } = await this.pool.query<{ user_id: string }>(
      `DELETE FROM federation_requests
       WHERE state = $1 AND binding_hash = $2 AND purpose = $3
         AND interaction IS NOT DISTINCT FROM $4 AND user_id IS NOT NULL AND expires_at > now()
       RETURNING user_id`,
      [state, sha256(binding), purpose, interaction],
    );
    return rows[0]?.user_id ?? null;
  }
}
