// SPDX-License-Identifier: AGPL-3.0-only
// The two protocols of identity providers: OpenID Connect (openid-client) and
// SAML 2.0 (node-saml). Both turn a provider's answer into a FederatedPerson.
import { createHash } from 'node:crypto';
import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
import * as client from 'openid-client';
import type pg from 'pg';
import type { OidcConfig, SamlConfig } from './config.ts';
import type { FederatedPerson } from './people.ts';
import type { PendingRequest } from './store.ts';

/** Where a provider sends people back to (registered at the provider). */
export const federationUrls = (issuer: string, id: string) => ({
  oidcRedirect: `${issuer}/federation/${id}/callback`,
  samlAcs: `${issuer}/federation/${id}/acs`,
  samlEntityId: `${issuer}/federation/${id}`,
  samlMetadata: `${issuer}/federation/${id}/metadata`,
});

// --- OpenID Connect ----------------------------------------------------------

const DISCOVERY_TTL_MS = 60 * 60_000;
const discovered = new Map<string, { config: client.Configuration; at: number }>();

/**
 * The provider's configuration (discovery cached for an hour, per settings).
 * Plain http issuers are allowed only where Cenacle ID itself runs on http
 * (development and tests).
 */
async function oidcConfiguration(
  issuer: string,
  config: OidcConfig,
  secret: string,
): Promise<client.Configuration> {
  const key = createHash('sha256')
    .update(JSON.stringify([config.issuer, config.clientId, secret]))
    .digest('base64url');
  const hit = discovered.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.config;
  const insecure = new URL(issuer).protocol === 'http:';
  const found = await client.discovery(
    new URL(config.issuer),
    config.clientId,
    undefined,
    client.ClientSecretBasic(secret),
    insecure ? { execute: [client.allowInsecureRequests], timeout: 10 } : { timeout: 10 },
  );
  discovered.set(key, { config: found, at: Date.now() });
  return found;
}

export async function oidcAuthorizationUrl(
  issuer: string,
  sourceId: string,
  config: OidcConfig,
  secret: string,
  request: PendingRequest,
): Promise<string> {
  const c = await oidcConfiguration(issuer, config, secret);
  return client.buildAuthorizationUrl(c, {
    redirect_uri: federationUrls(issuer, sourceId).oidcRedirect,
    scope: config.scopes,
    state: request.state,
    nonce: request.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(request.codeVerifier),
    code_challenge_method: 'S256',
  }).href;
}

/** Redeems the code of the callback and reads who signed in. */
export async function oidcPerson(
  issuer: string,
  config: OidcConfig,
  secret: string,
  request: PendingRequest,
  callbackUrl: URL,
): Promise<FederatedPerson> {
  const c = await oidcConfiguration(issuer, config, secret);
  const tokens = await client.authorizationCodeGrant(c, callbackUrl, {
    pkceCodeVerifier: request.codeVerifier,
    expectedState: request.state,
    expectedNonce: request.nonce,
    idTokenExpected: true,
  });
  let claims: Record<string, unknown> = { ...tokens.claims()! };
  // Address and groups may come only from userinfo.
  if (
    (claims.email === undefined ||
      (config.groupsClaim && claims[config.groupsClaim] === undefined)) &&
    c.serverMetadata().userinfo_endpoint
  ) {
    const info = await client.fetchUserInfo(c, tokens.access_token, String(claims.sub));
    claims = { ...info, ...claims };
  }
  const groups = config.groupsClaim ? claims[config.groupsClaim] : undefined;
  return {
    externalId: String(claims.sub),
    displayName: typeof claims.name === 'string' ? claims.name : '',
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true,
    groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [],
  };
}

// --- SAML 2.0 ----------------------------------------------------------------

const SAML_REQUEST_TTL_MS = 10 * 60_000;

/** The AuthnRequest ids we sent, kept in the database (shared by all instances). */
function requestIds(pool: pg.Pool): CacheProvider {
  return {
    async saveAsync(key, value) {
      await pool.query(
        `DELETE FROM saml_request_ids WHERE created_at < now() - make_interval(secs => $1)`,
        [SAML_REQUEST_TTL_MS / 1000],
      );
      await pool.query(
        'INSERT INTO saml_request_ids (id, issued_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [key, value],
      );
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      const { rows } = await pool.query<{ issued_at: string }>(
        `SELECT issued_at FROM saml_request_ids
         WHERE id = $1 AND created_at > now() - make_interval(secs => $2)`,
        [key, SAML_REQUEST_TTL_MS / 1000],
      );
      return rows[0]?.issued_at ?? null;
    },
    async removeAsync(key) {
      if (key === null) return null;
      const { rows } = await pool.query<{ issued_at: string }>(
        'DELETE FROM saml_request_ids WHERE id = $1 RETURNING issued_at',
        [key],
      );
      return rows[0]?.issued_at ?? null;
    },
  };
}

export function samlServiceProvider(
  pool: pg.Pool,
  issuer: string,
  sourceId: string,
  config: SamlConfig,
): SAML {
  const urls = federationUrls(issuer, sourceId);
  return new SAML({
    issuer: urls.samlEntityId,
    callbackUrl: urls.samlAcs,
    entryPoint: config.entryPoint,
    idpCert: splitCertificates(config.idpCert),
    idpIssuer: config.idpEntityId,
    audience: urls.samlEntityId,
    // The assertion must be signed by the provider; the response around it may be.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // Only answers to our own requests (no IdP-initiated sign-in).
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider: requestIds(pool),
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 60_000,
  });
}

function splitCertificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [pem];
}

function attribute(profile: Record<string, unknown>, name: string): unknown {
  if (!name) return undefined;
  const attrs = profile.attributes as Record<string, unknown> | undefined;
  return attrs?.[name] ?? profile[name];
}

const first = (v: unknown): string | null =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;

/** Validates a POSTed SAMLResponse and reads who signed in. */
export async function samlPerson(
  sp: SAML,
  config: SamlConfig,
  body: { SAMLResponse?: string; RelayState?: string },
): Promise<FederatedPerson> {
  const { profile } = await sp.validatePostResponseAsync({
    SAMLResponse: body.SAMLResponse ?? '',
    RelayState: body.RelayState ?? '',
  });
  if (!profile?.nameID) throw new Error('The SAML response names nobody.');
  const p = profile as unknown as Record<string, unknown>;
  const groups = attribute(p, config.groupsAttribute);
  const email =
    first(attribute(p, config.emailAttribute)) ??
    (profile.nameIDFormat === 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
      ? profile.nameID
      : null);
  return {
    externalId: profile.nameID,
    displayName: first(attribute(p, config.nameAttribute)) ?? '',
    email,
    emailVerified: config.trustEmail,
    groups: (Array.isArray(groups) ? groups : groups === undefined ? [] : [groups]).filter(
      (g): g is string => typeof g === 'string',
    ),
  };
}
