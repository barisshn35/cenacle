// SPDX-License-Identifier: Apache-2.0
import Provider, { type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import type { JWK } from 'jose';
import type pg from 'pg';
import type { UserStore } from '../accounts/users.ts';
import { pickLocale } from '../ui/messages.ts';
import { errorPage, loggedOutPage, logoutPage } from '../ui/pages.ts';
import { createPostgresAdapter } from './adapter.ts';
import type { ClientMetadata } from './clients.ts';
import { LOCALE_COOKIE, pageSecurityHeaders } from './security.ts';

export interface ProviderOptions {
  issuer: string;
  pool: pg.Pool;
  users: UserStore;
  clients: ClientMetadata[];
  signingKeys: JWK[];
  cookieKeys: string[];
  cookieDomain: string;
  trustProxy: boolean;
  /** Origins sign-in forms may redirect to (CSP form-action). */
  formActionOrigins: string[];
}

function localeOf(ctx: KoaContextWithOIDC): ReturnType<typeof pickLocale> {
  return pickLocale(
    ctx.cookies.get(LOCALE_COOKIE) ?? (ctx.oidc?.params?.ui_locales as string | undefined),
    ctx.get('accept-language'),
  );
}

function sendPage(ctx: KoaContextWithOIDC, body: string, formActionOrigins: string[]) {
  for (const [k, v] of Object.entries(pageSecurityHeaders(formActionOrigins))) ctx.set(k, v);
  ctx.type = 'html';
  ctx.body = body;
}

export function createProvider(opts: ProviderOptions): Provider {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    ...(opts.cookieDomain ? { domain: opts.cookieDomain } : {}),
  };

  const configuration: Configuration = {
    adapter: createPostgresAdapter(opts.pool),
    clients: opts.clients,
    // Custom client metadata: first-party clients skip consent.
    extraClientMetadata: { properties: ['cenacle_first_party'] },

    findAccount: async (_ctx, sub) => {
      const user = await opts.users.findById(sub);
      if (!user || user.disabled) return undefined;
      return {
        accountId: user.id,
        claims: async () => ({
          sub: user.id,
          email: user.email,
          email_verified: user.emailVerified,
          name: user.displayName,
          locale: user.locale ?? undefined,
          updated_at: Math.floor(user.updatedAt.getTime() / 1000),
        }),
      };
    },
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name', 'locale', 'updated_at'],
    },
    scopes: ['openid', 'email', 'profile'],

    // RFC 9700 (OAuth 2.0 Security BCP): authorization code flow only, PKCE for
    // every client, exact redirect_uri matching, short-lived artifacts.
    responseTypes: ['code'],
    pkce: { required: () => true },
    allowOmittingSingleRegisteredRedirectUri: false,
    // Confidential clients authenticate with HTTP Basic; no public clients yet.
    clientAuthMethods: ['client_secret_basic'],
    clientDefaults: {
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      id_token_signed_response_alg: 'RS256',
    },
    ttl: {
      AuthorizationCode: 60,
      AccessToken: 10 * 60,
      IdToken: 10 * 60,
      Interaction: 15 * 60,
      Session: 7 * 24 * 3600,
      Grant: 30 * 24 * 3600,
    },

    jwks: { keys: opts.signingKeys },
    cookies: {
      keys: opts.cookieKeys,
      long: { ...cookieOptions, signed: true },
      short: { ...cookieOptions, signed: true },
    },

    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (ctx, form) =>
          sendPage(ctx, logoutPage({ locale: localeOf(ctx), form }), opts.formActionOrigins),
        postLogoutSuccessSource: async (ctx) =>
          sendPage(ctx, loggedOutPage({ locale: localeOf(ctx) }), opts.formActionOrigins),
      },
    },

    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },

    // First-party clients get a grant for their registered scopes without a
    // consent screen; everything else would need consent (not offered yet).
    loadExistingGrant: async (ctx) => {
      const { client, session, result, provider } = ctx.oidc;
      if (!client || !session?.accountId) return undefined;
      const grantId = result?.consent?.grantId ?? session.grantIdFor(client.clientId);
      if (grantId) {
        const existing = await provider.Grant.find(grantId);
        if (existing) return existing;
      }
      if (!client['cenacle_first_party']) return undefined;
      const grant = new provider.Grant({ clientId: client.clientId, accountId: session.accountId });
      grant.addOIDCScope(client.scope ?? 'openid');
      await grant.save();
      return grant;
    },

    renderError: async (ctx, out) => {
      sendPage(
        ctx,
        errorPage({
          locale: localeOf(ctx),
          code: String(out.error ?? 'server_error'),
          requestId: ctx.get('x-request-id') || undefined,
        }),
        opts.formActionOrigins,
      );
    },
  };

  const provider = new Provider(opts.issuer, configuration);
  provider.proxy = opts.trustProxy;
  return provider;
}
