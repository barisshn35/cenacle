// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type pg from 'pg';

/** A challenge is answered within this time (the browser's prompt included). */
const CHALLENGE_TTL_SECONDS = 300;
/** Passkeys per account. */
export const MAX_PASSKEYS = 20;

export type SignInPurpose = 'login' | 'account';

export interface Passkey {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** Synced across devices (a password manager or platform account). */
  synced: boolean;
}

/** The WebAuthn user handle of an account: its id's 16 bytes (opaque, stable). */
function userHandle(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId.replace(/-/g, ''), 'hex'));
}

function handleToUserId(handle: string): string | null {
  const hex = Buffer.from(handle, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Passkeys (WebAuthn, discoverable credentials with user verification): the
 * relying party is Cenacle ID's own host, so passkeys work for every app that
 * signs in with it.
 */
export class PasskeyStore {
  readonly rpID: string;
  readonly origin: string;

  constructor(
    private readonly pool: pg.Pool,
    issuer: string,
    private readonly rpName = 'Cenacle ID',
  ) {
    const url = new URL(issuer);
    this.rpID = url.hostname;
    this.origin = url.origin;
  }

  async list(userId: string): Promise<Passkey[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      created_at: Date;
      last_used_at: Date | null;
      device_type: string;
    }>(
      `SELECT id, name, created_at, last_used_at, device_type FROM passkeys
       WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      synced: r.device_type === 'multiDevice',
    }));
  }

  async any(userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM passkeys WHERE user_id = $1', [
      userId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /** Removes a passkey of the account; false when there was none. */
  async remove(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM passkeys WHERE user_id = $1 AND id = $2',
      [userId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- registration ---------------------------------------------------------

  async registrationOptions(user: {
    id: string;
    displayName: string;
    email: string | null;
    username: string | null;
  }): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    const { rows } = await this.pool.query<{ id: string; transports: string[] }>(
      'SELECT id, transports FROM passkeys WHERE user_id = $1',
      [user.id],
    );
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: userHandle(user.id),
      userName: user.email ?? user.username ?? user.displayName,
      userDisplayName: user.displayName,
      attestationType: 'none',
      // The same authenticator is not registered twice.
      excludeCredentials: rows.map((r) => ({ id: r.id, transports: r.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = await this.saveChallenge('register', options.challenge, {
      userId: user.id,
    });
    return { challengeId, options };
  }

  /** Verifies and stores a new passkey; the reason when it cannot be added. */
  async register(
    userId: string,
    challengeId: string,
    response: RegistrationResponseJSON,
    name: string,
  ): Promise<'ok' | 'expired' | 'invalid' | 'limit'> {
    const challenge = await this.takeChallenge(challengeId, 'register');
    if (!challenge || challenge.userId !== userId) return 'expired';
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1',
      [userId],
    );
    if (rows[0]!.n >= MAX_PASSKEYS) return 'limit';
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
    } catch {
      return 'invalid';
    }
    if (!verified.verified) return 'invalid';
    const info = verified.registrationInfo;
    const result = await this.pool.query(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [
        info.credential.id,
        userId,
        Buffer.from(info.credential.publicKey),
        info.credential.counter,
        info.credential.transports ?? [],
        info.credentialDeviceType,
        info.credentialBackedUp,
        name.trim().slice(0, 80) || this.rpName,
      ],
    );
    return (result.rowCount ?? 0) > 0 ? 'ok' : 'invalid';
  }

  // --- sign-in --------------------------------------------------------------

  async authenticationOptions(
    purpose: SignInPurpose,
    interaction?: string,
  ): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    // No allowCredentials: the browser offers the passkeys it has for us.
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
    });
    const challengeId = await this.saveChallenge(purpose, options.challenge, { interaction });
    return { challengeId, options };
  }

  /** The account a passkey assertion signs in, or null. */
  async authenticate(
    purpose: SignInPurpose,
    challengeId: string,
    response: AuthenticationResponseJSON,
    interaction?: string,
  ): Promise<{ userId: string; synced: boolean } | null> {
    const challenge = await this.takeChallenge(challengeId, purpose);
    if (!challenge || (challenge.interaction ?? undefined) !== interaction) return null;
    const { rows } = await this.pool.query<{
      user_id: string;
      public_key: Buffer;
      counter: string;
      transports: string[];
      device_type: string;
    }>('SELECT user_id, public_key, counter, transports, device_type FROM passkeys WHERE id = $1', [
      response.id,
    ]);
    const stored = rows[0];
    if (!stored) return null;
    // A discoverable credential names its account: it must be the stored one.
    const handle: unknown = response.response.userHandle;
    if (
      handle != null &&
      (typeof handle !== 'string' || handleToUserId(handle) !== stored.user_id)
    ) {
      return null;
    }
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: response.id,
          publicKey: new Uint8Array(stored.public_key),
          counter: Number(stored.counter),
          transports: stored.transports,
        },
      });
    } catch {
      return null;
    }
    if (!verified.verified) return null;
    await this.pool.query(
      `UPDATE passkeys SET counter = $2, backed_up = $3, last_used_at = now() WHERE id = $1`,
      [
        response.id,
        verified.authenticationInfo.newCounter,
        verified.authenticationInfo.credentialBackedUp,
      ],
    );
    return { userId: stored.user_id, synced: stored.device_type === 'multiDevice' };
  }

  // --- challenges -----------------------------------------------------------

  private async saveChallenge(
    purpose: SignInPurpose | 'register',
    challenge: string,
    bind: { userId?: string; interaction?: string },
  ): Promise<string> {
    const id = randomBytes(24).toString('base64url');
    await this.pool.query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
    await this.pool.query(
      `INSERT INTO webauthn_challenges (id, purpose, interaction, user_id, challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [
        id,
        purpose,
        bind.interaction ?? null,
        bind.userId ?? null,
        challenge,
        CHALLENGE_TTL_SECONDS,
      ],
    );
    return id;
  }

  /** Takes a live challenge (once: a second answer finds nothing). */
  private async takeChallenge(id: string, purpose: SignInPurpose | 'register') {
    if (!id) return null;
    const { rows } = await this.pool.query<{
      challenge: string;
      user_id: string | null;
      interaction: string | null;
    }>(
      `DELETE FROM webauthn_challenges WHERE id = $1 AND purpose = $2 AND expires_at > now()
       RETURNING challenge, user_id, interaction`,
      [id, purpose],
    );
    const row = rows[0];
    return row
      ? { challenge: row.challenge, userId: row.user_id, interaction: row.interaction }
      : null;
  }
}
