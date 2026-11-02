// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import type { AuditLog } from '../accounts/audit.ts';
import type { MfaStore } from '../accounts/mfa.ts';
import type { PasskeyStore } from '../accounts/passkeys.ts';
import { DEFAULT_POLICY, type PolicyStore, type SignInPolicy } from '../accounts/policy.ts';
import {
  checkPasskey,
  checkPassword,
  usernamesAllowed,
  type DirectoryAccess,
} from '../accounts/signin.ts';
import type { UserStore } from '../accounts/users.ts';
import { FEDERATION_COOKIE } from '../federation/routes.ts';
import type { ProviderStore } from '../federation/store.ts';
import { isLocale, pickLocale, type Locale } from '../ui/messages.ts';
import QRCode from 'qrcode';
import {
  errorPage,
  LANG_PARAM,
  loginPage,
  recoveryCodesPage,
  secondStepPage,
  setupPage,
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
  /** Directories (LDAP / Active Directory) people may sign in with. */
  directory?: DirectoryAccess;
  /** Passkeys (WebAuthn); without them the passkey sign-in answers 404. */
  passkeys?: PasskeyStore;
  /** Identity providers people may sign in with (OIDC, SAML). */
  federation?: ProviderStore;
  /**
   * The sign-in policy (v0.29). Without it (tests of the bare flow) two-step
   * verification is optional and passkeys are allowed.
   */
  policy?: PolicyStore;
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

  const usernames = () => usernamesAllowed(opts.directory);
  /** The sign-in policy; without a store, the behaviour before v0.29. */
  const policy = async (): Promise<SignInPolicy> =>
    opts.policy
      ? await opts.policy.get()
      : { ...DEFAULT_POLICY, requireTwoStep: false, passkeys: true };
  const providers = async () => (opts.federation ? await opts.federation.enabled() : []);

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
          usernames: await usernames(),
          providers: await providers(),
          passkeys: (await policy()).passkeys,
          error: request.query.federation_error ? 'federation' : undefined,
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
              usernames: await usernames(),
              providers: await providers(),
              passkeys: (await policy()).passkeys,
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
      const result =
        email && password
          ? await checkPassword(users, opts.directory, email, password, (err) =>
              request.log.warn({ err }, 'directory sign-in failed'),
            )
          : null;
      const user = result && 'user' in result ? result.user : null;
      if (result && 'error' in result && result.error === 'unavailable') error = 'unavailable';
      if (!email || !password) error = 'missing';
      else if (!user && !error) error = 'invalid';
      if (error || !user) {
        request.log.info({ uid: d.uid }, 'sign-in failed');
        const failedFor = result && 'userId' in result ? (result.userId ?? null) : null;
        await opts.audit?.record('signin.failed', failedFor, request.ip, {
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
            usernames: await usernames(),
            providers: await providers(),
            passkeys: (await policy()).passkeys,
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
            client: await clientName(d.params.client_id),
            action: `/interaction/${d.uid}/second-step`,
            cancelAction: `/interaction/${d.uid}/abort`,
          }),
        );
      }
      if (opts.mfa && (await policy()).requireTwoStep) {
        // Required but not set up yet: set it up now, then the sign-in goes on.
        await opts.mfa.createChallenge(user.id, 'login', d.uid);
        return renderSetup(
          reply,
          locale(request, d.params.ui_locales),
          d.uid,
          await clientName(d.params.client_id),
          user,
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

  /** The setup of a required two-step verification, inside the sign-in. */
  async function renderSetup(
    reply: FastifyReply,
    loc: Locale,
    uid: string,
    client: string,
    user: { id: string; email: string | null; username: string | null; displayName: string },
    error?: CodeError,
  ) {
    const mfa = opts.mfa!;
    // The authenticator shows the account by its address (or sign-in name).
    const label = user.email ?? user.username ?? user.displayName;
    // Every setup gets a new secret (one shown earlier is never confirmed
    // later); a wrong code shows the same one again.
    const setup =
      (error ? await mfa.pendingSecret(user.id, label) : null) ??
      (await mfa.beginSetup(user.id, label));
    const qrSvg = await QRCode.toString(setup.uri, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return page(
      reply,
      error ? 401 : 200,
      setupPage({
        locale: loc,
        secret: setup.secret,
        qrSvg,
        error,
        interaction: {
          action: `/interaction/${uid}/two-step-setup`,
          cancelAction: `/interaction/${uid}/abort`,
          client,
        },
      }),
    );
  }

  app.post<{ Params: Params; Body: { code?: string } }>(
    '/interaction/:uid/two-step-setup',
    { config: { rateLimit: { max: opts.loginRateLimit ?? 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const mfa = opts.mfa;
      const d = await details(request, reply);
      if (!mfa || !d || d.uid !== request.params.uid || d.prompt.name !== 'login') {
        return expired(request, reply);
      }
      const loc = locale(request, d.params.ui_locales);
      const challenge = await mfa.takeAttempt(d.uid, 'login');
      if (!challenge) return expired(request, reply);
      const user = await users.findById(challenge.userId);
      if (!user) return expired(request, reply);
      const codes = await mfa.confirmSetup(user.id, (request.body?.code ?? '').replace(/\s/g, ''));
      if (!codes) {
        await opts.audit?.record('signin.second_step_failed', user.id, request.ip, {
          client: d.params.client_id,
        });
        if (challenge.attemptsLeft <= 0) return expired(request, reply);
        return renderSetup(reply, loc, d.uid, await clientName(d.params.client_id), user, {
          attemptsLeft: challenge.attemptsLeft,
        });
      }
      await mfa.passed(challenge);
      await opts.audit?.record('two_step.enabled', user.id, request.ip);
      await mfa.confirmSetupChallenge(d.uid, user.id);
      return page(
        reply,
        200,
        recoveryCodesPage({
          locale: loc,
          codes,
          continueAction: `/interaction/${d.uid}/two-step-done`,
          client: await clientName(d.params.client_id),
        }),
      );
    },
  );

  app.post<{ Params: Params }>('/interaction/:uid/two-step-done', async (request, reply) => {
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const mfa = opts.mfa;
    const d = await details(request, reply);
    if (!mfa || !d || d.uid !== request.params.uid || d.prompt.name !== 'login') {
      return expired(request, reply);
    }
    // Only a setup confirmed with a code in this sign-in finishes it, once: the
    // password's own challenge is not enough.
    const userId = await mfa.takeConfirmedSetup(d.uid);
    if (!userId || !(await mfa.enabled(userId))) return expired(request, reply);
    request.log.info({ uid: d.uid, sub: userId }, 'sign-in succeeded');
    await opts.audit?.record('signin.succeeded', userId, request.ip, {
      client: d.params.client_id,
      second_step: 'totp',
    });
    reply.hijack();
    await provider.interactionFinished(
      request.raw,
      reply.raw,
      { login: { accountId: userId, amr: ['pwd', 'otp', 'mfa'] } },
      { mergeWithLastSubmission: false },
    );
  });

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
      const client = await clientName(d.params.client_id);
      const show = (status: number, error: CodeError) =>
        page(
          reply,
          status,
          secondStepPage({
            locale: loc,
            client,
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
      await mfa.passed(challenge);
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

  const limited = {
    config: { rateLimit: { max: opts.loginRateLimit ?? 10, timeWindow: '1 minute' } },
  };

  app.post<{ Params: Params }>(
    '/interaction/:uid/passkey/options',
    limited,
    async (request, reply) => {
      if (!opts.passkeys || !(await policy()).passkeys) return reply.code(404).send();
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const d = await details(request, reply);
      if (!d || d.uid !== request.params.uid || d.prompt.name !== 'login') {
        return reply.code(400).send();
      }
      return reply
        .header('cache-control', 'no-store')
        .send(await opts.passkeys.authenticationOptions('login', d.uid));
    },
  );

  app.post<{ Params: Params; Body: { challenge?: string; response?: string } }>(
    '/interaction/:uid/passkey',
    limited,
    async (request, reply) => {
      if (!opts.passkeys || !(await policy()).passkeys) return reply.code(404).send();
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const d = await details(request, reply);
      if (!d || d.uid !== request.params.uid || d.prompt.name !== 'login') {
        return expired(request, reply);
      }
      const result = await checkPasskey(users, opts.passkeys, 'login', request.body, d.uid);
      if (!result) {
        request.log.info({ uid: d.uid }, 'passkey sign-in failed');
        await opts.audit?.record('signin.passkey_failed', null, request.ip, {
          client: d.params.client_id,
        });
        return page(
          reply,
          401,
          loginPage({
            locale: locale(request, d.params.ui_locales),
            uid: d.uid,
            clientName: await clientName(d.params.client_id),
            error: 'passkey',
            usernames: await usernames(),
            providers: await providers(),
          }),
        );
      }
      const { user, synced } = result;
      request.log.info({ uid: d.uid, sub: user.id }, 'sign-in succeeded');
      await opts.audit?.record('signin.succeeded', user.id, request.ip, {
        client: d.params.client_id,
        method: 'passkey',
      });
      reply.hijack();
      // A passkey is possession of a key plus user verification: two factors
      // (RFC 8176: hwk for a device-bound key, swk for a synced one).
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        { login: { accountId: user.id, amr: [synced ? 'swk' : 'hwk', 'mfa'] } },
        { mergeWithLastSubmission: false },
      );
    },
  );

  app.get<{ Params: Params; Querystring: { state?: string } }>(
    '/interaction/:uid/federated',
    async (request, reply) => {
      if (!opts.federation) return reply.code(404).send();
      const d = await details(request, reply);
      if (!d || d.uid !== request.params.uid || d.prompt.name !== 'login') {
        return expired(request, reply);
      }
      const userId = await opts.federation.finish(
        request.query.state ?? '',
        request.cookieValue(FEDERATION_COOKIE),
        'login',
        d.uid,
      );
      const user = userId ? await users.findById(userId) : null;
      if (!user || user.disabled) {
        return reply.redirect(`/interaction/${encodeURIComponent(d.uid)}?federation_error=1`, 303);
      }
      request.log.info({ uid: d.uid, sub: user.id }, 'sign-in succeeded');
      await opts.audit?.record('signin.succeeded', user.id, request.ip, {
        client: d.params.client_id,
        method: 'federation',
      });
      reply.hijack();
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        { login: { accountId: user.id } },
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
