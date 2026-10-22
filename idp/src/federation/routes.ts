// SPDX-License-Identifier: AGPL-3.0-only
// Signing in with another identity provider: /federation/:id/start sends the
// person there; its answer comes back to /callback (OIDC) or /acs (SAML),
// is verified and attached to the request; the browser that started it then
// finishes at /interaction/:uid/federated or /account/federated.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AuditLog } from '../accounts/audit.ts';
import { LOCALE_COOKIE, pageSecurityHeaders } from '../oidc/security.ts';
import { pickLocale } from '../ui/messages.ts';
import { errorPage } from '../ui/pages.ts';
import { signInFederated, type FederatedPerson } from './people.ts';
import { oidcAuthorizationUrl, oidcPerson, samlPerson, samlServiceProvider } from './protocols.ts';
import type { PendingRequest, Provider, ProviderStore } from './store.ts';

/** Ties a sign-in at a provider to the browser that started it. */
export const FEDERATION_COOKIE = 'cenacle_id_federation';

export function federationCookie(value: string, secure: boolean, maxAge = 600): string {
  return `${FEDERATION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
}

export interface FederationOptions {
  pool: pg.Pool;
  providers: ProviderStore;
  audit: AuditLog;
  issuer: string;
  formActionOrigins: string[];
}

/** Where a request is finished, or where to go back to when it failed. */
function back(request: PendingRequest, state?: string): string {
  const base =
    request.purpose === 'login'
      ? `/interaction/${encodeURIComponent(request.interaction!)}`
      : '/account';
  return state
    ? `${base}/federated?state=${encodeURIComponent(state)}`
    : `${base}?federation_error=1`;
}

export async function registerFederation(app: FastifyInstance, opts: FederationOptions) {
  const { pool, providers, audit, issuer, formActionOrigins } = opts;
  const secure = new URL(issuer).protocol === 'https:';

  function failure(request: FastifyRequest, reply: FastifyReply, status: number, code: string) {
    return reply
      .code(status)
      .headers(pageSecurityHeaders(formActionOrigins))
      .type('text/html; charset=utf-8')
      .send(
        errorPage({
          locale: pickLocale(
            request.cookieValue(LOCALE_COOKIE),
            request.headers['accept-language'],
          ),
          code,
          requestId: request.id,
        }),
      );
  }

  async function enabledProvider(id: string): Promise<Provider | null> {
    const p = await providers.get(id);
    return p?.enabled ? p : null;
  }

  app.get<{ Params: { id: string }; Querystring: { interaction?: string; purpose?: string } }>(
    '/federation/:id/start',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const provider = await enabledProvider(request.params.id);
      if (!provider) return reply.code(404).send();
      const interaction = request.query.interaction;
      const login = interaction !== undefined;
      if (login ? !/^[\w-]{10,64}$/.test(interaction) : request.query.purpose !== 'account') {
        return reply.code(400).send();
      }
      const { request: pending, binding } = await providers.begin(
        provider.id,
        login ? 'login' : 'account',
        login ? interaction : null,
      );
      let url: string;
      try {
        url =
          provider.kind === 'oidc'
            ? await oidcAuthorizationUrl(
                issuer,
                provider.id,
                provider.config,
                await providers.secret(provider.id),
                pending,
              )
            : await samlServiceProvider(
                pool,
                issuer,
                provider.id,
                provider.config,
              ).getAuthorizeUrlAsync(pending.state, undefined, {});
      } catch (err) {
        request.log.warn({ err, provider: provider.id }, 'identity provider unavailable');
        return failure(request, reply, 502, 'provider_unavailable');
      }
      reply.header('set-cookie', federationCookie(binding, secure));
      return reply.redirect(url, 303);
    },
  );

  /** Attaches the verified person to the request and sends the browser on. */
  async function answered(
    request: FastifyRequest,
    reply: FastifyReply,
    provider: Provider,
    pending: PendingRequest,
    read: () => Promise<FederatedPerson>,
  ) {
    let person: FederatedPerson;
    try {
      person = await read();
    } catch (err) {
      request.log.info({ err, provider: provider.id }, 'identity provider answer refused');
      await audit.record('signin.federation_failed', null, request.ip, { provider: provider.id });
      return reply.redirect(back(pending), 303);
    }
    const result = await signInFederated(pool, provider, person);
    if ('error' in result || !(await providers.answer(pending.state, result.userId))) {
      await audit.record(
        'signin.federation_failed',
        'userId' in result ? result.userId : null,
        request.ip,
        { provider: provider.id, reason: 'error' in result ? result.error : 'expired' },
      );
      return reply.redirect(back(pending), 303);
    }
    return reply.redirect(back(pending, pending.state), 303);
  }

  app.get<{ Params: { id: string }; Querystring: { state?: string } }>(
    '/federation/:id/callback',
    async (request, reply) => {
      const provider = await enabledProvider(request.params.id);
      if (provider?.kind !== 'oidc') return reply.code(404).send();
      const pending = await providers.pending(provider.id, request.query.state ?? '');
      if (!pending) return failure(request, reply, 400, 'federation_expired');
      return answered(request, reply, provider, pending, async () =>
        oidcPerson(
          issuer,
          provider.config,
          await providers.secret(provider.id),
          pending,
          new URL(request.url, issuer),
        ),
      );
    },
  );

  // The provider posts here from its own site: no same-origin check (the
  // assertion is signed, answers our request id and names our state).
  app.post<{ Params: { id: string }; Body: { SAMLResponse?: string; RelayState?: string } }>(
    '/federation/:id/acs',
    { bodyLimit: 512 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const provider = await enabledProvider(request.params.id);
      if (provider?.kind !== 'saml') return reply.code(404).send();
      const pending = await providers.pending(provider.id, request.body?.RelayState ?? '');
      if (!pending) return failure(request, reply, 400, 'federation_expired');
      const sp = samlServiceProvider(pool, issuer, provider.id, provider.config);
      return answered(request, reply, provider, pending, () =>
        samlPerson(sp, provider.config, request.body ?? {}),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/federation/:id/metadata', async (request, reply) => {
    const provider = await providers.get(request.params.id);
    if (provider?.kind !== 'saml') return reply.code(404).send();
    const xml = samlServiceProvider(
      pool,
      issuer,
      provider.id,
      provider.config,
    ).generateServiceProviderMetadata(null);
    return reply.type('application/samlmetadata+xml').send(xml);
  });
}
