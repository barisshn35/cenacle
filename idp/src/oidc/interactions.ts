// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import type { AuditLog } from '../accounts/audit.ts';
import type { MfaStore } from '../accounts/mfa.ts';
import type { UserStore } from '../accounts/users.ts';
import { isLocale, pickLocale, type Locale } from '../ui/messages.ts';
import {
  errorPage,
  LANG_PARAM,
  loginPage,
  secondStepPage,
  type CodeError,
  type LoginError,
} from '../ui/pages.ts';
import { isSameOriginPost, LOCALE_COOKIE, pageSecurityHeaders } from './security.ts';

export interface InteractionOptions {
  provider: Provider;
  users: UserStore;
  /** Two-step verification and the audit log (optional in tests of the bare flow). */
  mfa?: MfaStore;
  audit?: AuditLog;
  issuer: string;
  formActionOrigins: string[];
  /** Sign-in attempts per IP and minute. */
  loginRateLimit?: number;
}

interface Params {
  uid: string;
}

/**
 * Sign-in pages for oidc-provider interactions: GET shows the form, POST
 * checks the credentials, abort cancels the authorization request.
 */
export async function registerInteractions(app: FastifyInstance, opts: InteractionOptions) {
  const { provider, users, issuer, formActionOrigins } = opts;
  const secure = new URL(issuer).protocol === 'https:';

  function locale(request: FastifyRequest, uiLocales?: unknown): Locale {
    const cookie = request.cookieValue(LOCALE_COOKIE);
    return pickLocale(
      cookie ?? (typeof uiLocales === 'string' ? uiLocales : undefined),
      request.headers['accept-language'],
    );
  }

  function page(reply: FastifyReply, status: number, body: string) {
    return reply
      .code(status)
      .headers(pageSecurityHeaders(formActionOrigins))
      .type('text/html; charset=utf-8')
      .send(body);
  }

  function clientName(clientId: unknown): Promise<string> {
    return provider.Client.find(String(clientId)).then((c) => c?.clientName ?? String(clientId));
  }

  async function details(request: FastifyRequest, reply: FastifyReply) {
    try {
      return await provider.interactionDetails(request.raw, reply.raw);
    } catch {
      return null;
    }
  }

  function expired(request: FastifyRequest, reply: FastifyReply) {
    return page(
      reply,
      400,
      errorPage({ locale: locale(request), code: 'interaction_expired', requestId: request.id }),
    );
  }

  app.get<{ Params: Params; Querystring: Record<string, string | undefined> }>(
    '/interaction/:uid',
    async (request, reply) => {
      const chosen = request.query[LANG_PARAM];
      if (isLocale(chosen)) {
        reply.header(
          'set-cookie',
          `${LOCALE_COOKIE}=${chosen}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`,
        );
        return reply.redirect(`/interaction/${encodeURIComponent(request.params.uid)}`, 303);
      }
      const d = await details(request, reply);
      if (!d || d.uid !== request.params.uid) return expired(request, reply);
      const loc = locale(request, d.params.ui_locales);
      if (d.prompt.name !== 'login') {
        // Consent is only granted automatically to first-party clients (v0.2).
        return page(
          reply,
          400,
          errorPage({
            locale: loc,
            code: 'consent_required',
            requestId: request.id,
            unsupportedClient: true,
          }),
        );
      }
      return page(
        reply,
        200,
        loginPage({
          locale: loc,
          uid: d.uid,
          clientName: await clientName(d.params.client_id),
          email: typeof d.params.login_hint === 'string' ? d.params.login_hint : undefined,
        }),
      );
    },
  );

  app.post<{ Params: Params; Body: { email?: string; password?: string } }>(
    '/interaction/:uid/login',
    {
      config: {
        rateLimit: {
          max: opts.loginRateLimit ?? 10,
          timeWindow: '1 minute',
        },
      },
      errorHandler: async (error, request, reply) => {
        if (error.statusCode === 429) {
          const d = await details(request, reply);
          if (!d) return expired(request, reply);
          const retry = Number(reply.getHeader('retry-after') ?? 60);
          return page(
            reply,
            429,
            loginPage({
              locale: locale(request, d.params.ui_locales),
              uid: d.uid,
              clientName: await clientName(d.params.client_id),
              error: { rateLimited: retry },
            }),
          );
        }
        throw error;
      },
    },
    async (request, reply) => {
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const d = await details(request, reply);
      if (!d || d.uid !== request.params.uid || d.prompt.name !== 'login') {
        return expired(request, reply);
      }
      const email = (request.body?.email ?? '').trim();
      const password = request.body?.password ?? '';
      let error: LoginError | undefined;
      const user = email && password ? await users.authenticate(email, password) : null;
      if (!email || !password) error = 'missing';
      else if (!user) error = 'invalid';
      if (error || !user) {
        request.log.info({ uid: d.uid }, 'sign-in failed');
        await opts.audit?.record('signin.failed', null, request.ip, {
          email,
          client: d.params.client_id,
        });
        return page(
          reply,
          401,
          loginPage({
            locale: locale(request, d.params.ui_locales),
            uid: d.uid,
            clientName: await clientName(d.params.client_id),
            email,
            error,
          }),
        );
      }
      if (opts.mfa && (await opts.mfa.enabled(user.id))) {
        // The password is right; the second step is bound to this interaction.
        await opts.mfa.createChallenge(user.id, 'login', d.uid);
        return page(
          reply,
          200,
          secondStepPage({
            locale: locale(request, d.params.ui_locales),
            action: `/interaction/${d.uid}/second-step`,
            cancelAction: `/interaction/${d.uid}/abort`,
          }),
        );
      }
      request.log.info({ uid: d.uid, sub: user.id }, 'sign-in succeeded');
      await opts.audit?.record('signin.succeeded', user.id, request.ip, {
        client: d.params.client_id,
      });
      reply.hijack();
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        { login: { accountId: user.id, amr: ['pwd'] } },
        { mergeWithLastSubmission: false },
      );
    },
  );

  app.post<{ Params: Params; Body: { code?: string } }>(
    '/interaction/:uid/second-step',
    { config: { rateLimit: { max: opts.loginRateLimit ?? 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const mfa = opts.mfa;
      const d = await details(request, reply);
      if (!mfa || !d || d.uid !== request.params.uid || d.prompt.name !== 'login') {
        return expired(request, reply);
      }
      const loc = locale(request, d.params.ui_locales);
      const show = (status: number, error: CodeError) =>
        page(
          reply,
          status,
          secondStepPage({
            locale: loc,
            action: `/interaction/${d.uid}/second-step`,
            cancelAction: `/interaction/${d.uid}/abort`,
            error,
          }),
        );
      const challenge = await mfa.takeAttempt(d.uid, 'login');
      if (!challenge) return show(400, 'expired');
      const factor = await mfa.verify(challenge.userId, request.body?.code ?? '');
      if (!factor) {
        request.log.info({ uid: d.uid }, 'second step failed');
        await opts.audit?.record('signin.second_step_failed', challenge.userId, request.ip, {
          client: d.params.client_id,
        });
        const left = challenge.attemptsLeft;
        return show(401, left > 0 ? { attemptsLeft: left } : 'expired');
      }
      await mfa.finishChallenge(d.uid);
      request.log.info({ uid: d.uid, sub: challenge.userId }, 'sign-in succeeded');
      if (factor === 'recovery') {
        await opts.audit?.record('recovery_code.used', challenge.userId, request.ip);
      }
      await opts.audit?.record('signin.succeeded', challenge.userId, request.ip, {
        client: d.params.client_id,
        second_step: factor,
      });
      reply.hijack();
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        {
          login: {
            accountId: challenge.userId,
            // RFC 8176: password plus a one-time code (or a recovery code).
            amr: factor === 'totp' ? ['pwd', 'otp', 'mfa'] : ['pwd', 'mfa'],
          },
        },
        { mergeWithLastSubmission: false },
      );
    },
  );

  app.post<{ Params: Params }>('/interaction/:uid/abort', async (request, reply) => {
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const d = await details(request, reply);
    if (!d || d.uid !== request.params.uid) return expired(request, reply);
    reply.hijack();
    await provider.interactionFinished(
      request.raw,
      reply.raw,
      { error: 'access_denied', error_description: 'End-user cancelled sign-in' },
      { mergeWithLastSubmission: false },
    );
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    cookieValue(name: string): string | undefined;
  }
}
