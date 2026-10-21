// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Registered OIDC clients (JSON file, IDP_CLIENTS_FILE). Secrets are read from
 * separate files so the client list itself can be kept in version control.
 * Only the authorization code flow with a confidential client is allowed
 * (RFC 9700); PKCE is enforced for every client by the provider.
 */
const httpsOrLoopback = z.url().refine((u) => {
  const url = new URL(u);
  return (
    !url.hash &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  );
}, 'must be https (http only for localhost) and must not contain a fragment');

const clientSchema = z
  .object({
    client_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
    client_name: z.string().min(1).max(100),
    client_secret_file: z.string().min(1),
    redirect_uris: z.array(httpsOrLoopback).min(1),
    post_logout_redirect_uris: z.array(httpsOrLoopback).default([]),
    /** First-party clients (Cenacle itself) skip the consent screen. */
    first_party: z.boolean().default(false),
    scope: z.string().default('openid email profile'),
  })
  .strict();

const fileSchema = z.array(clientSchema).min(1);

export interface ClientMetadata {
  [key: string]: unknown;
  client_id: string;
  client_name: string;
  client_secret: string;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  grant_types: ['authorization_code'];
  response_types: ['code'];
  token_endpoint_auth_method: 'client_secret_basic';
  scope: string;
  cenacle_first_party: boolean;
}

/**
 * Replaces ${NAME} with environment variables (e.g. ${CENACLE_DOMAIN}), so
 * host names stay configuration. A missing variable is an error.
 */
export function interpolate(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new Error(`clients file uses \${${name}}, which is not set`);
    }
    return value;
  });
}

export function loadClients(
  file: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  env: Record<string, string | undefined> = process.env,
): ClientMetadata[] {
  const parsed = fileSchema.parse(JSON.parse(interpolate(readFile(file), env)));
  const ids = new Set<string>();
  return parsed.map((c) => {
    if (ids.has(c.client_id)) throw new Error(`duplicate client_id ${c.client_id}`);
    ids.add(c.client_id);
    const secret = readFile(resolve(dirname(file), c.client_secret_file)).trim();
    if (secret.length < 32) throw new Error(`client ${c.client_id}: secret needs 32+ characters`);
    return {
      client_id: c.client_id,
      client_name: c.client_name,
      client_secret: secret,
      redirect_uris: c.redirect_uris,
      post_logout_redirect_uris: c.post_logout_redirect_uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      scope: c.scope,
      cenacle_first_party: c.first_party,
    };
  });
}

/** Origins that sign-in forms may redirect to (CSP form-action). */
export function clientOrigins(clients: ClientMetadata[]): string[] {
  const origins = new Set<string>();
  for (const c of clients) {
    for (const u of [...c.redirect_uris, ...c.post_logout_redirect_uris]) {
      origins.add(new URL(u).origin);
    }
  }
  return [...origins];
}
