// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { AuditLog } from '../accounts/audit.ts';
import type { MfaStore } from '../accounts/mfa.ts';
import type { UserStore } from '../accounts/users.ts';
import { isSameOriginPost, LOCALE_COOKIE, pageSecurityHeaders } from '../oidc/security.ts';
import { isLocale, MESSAGES, pickLocale, type Locale } from '../ui/messages.ts';
import {
  accountPage,
  accountSigninPage,
  confirmWithCodePage,
  LANG_PARAM,
  recoveryCodesPage,
  secondStepPage,
  setupPage,
  type CodeError,
} from '../ui/pages.ts';
import {
  accountCookie,
  ACCOUNT_COOKIE,
  clearAccountCookie,
  signAccount,
  verifyAccount,
} from './session.ts';

/** Where "Back to Cenacle" leads (an app origin), remembered for the visit. */
const RETURN_COOKIE = 'cenacle_id_return';

export interface AccountOptions {
  users: UserStore;
  mfa: MfaStore;
  audit: AuditLog;
  issuer: string;
  cookieKeys: string[];
  /** Origins of the registered apps: CSP form-action and allowed return links. */
  formActionOrigins: string[];
  /** Sign-in attempts per address and minute. */
  rateLimit?: number;
}

type CodeBody = { code?: string; challenge?: string };

/**
 * The account pages (/account): sign in with password and second step, turn
 * two-step verification on and off, new recovery codes, recent activity.
 */
export async function registerAccount(app: FastifyInstance, opts: AccountOptions) {
  const { users, mfa, audit, issuer, cookieKeys, formActionOrigins } = opts;
  const secure = new URL(issuer).protocol === 'https:';
  const limited = { config: { rateLimit: { max: opts.rateLimit ?? 10, timeWindow: '1 minute' } } };

  const locale = (request: FastifyRequest): Locale =>
    pickLocale(request.cookieValue(LOCALE_COOKIE), request.headers['accept-language']);

  function page(reply: FastifyReply, status: number, body: string) {
    return reply
      .code(status)
      .headers(pageSecurityHeaders(formActionOrigins))
      .type('text/html; charset=utf-8')
      .send(body);
  }

  /** The signed-in user of the account pages, or null. */
  async function current(request: FastifyRequest) {
    const sub = verifyAccount(cookieKeys, request.cookieValue(ACCOUNT_COOKIE));
    if (!sub) return null;
    const user = await users.findById(sub);
    return user && !user.disabled ? user : null;
  }

  function signedIn(reply: FastifyReply, userId: string) {
    reply.header('set-cookie', accountCookie(signAccount(cookieKeys, userId), secure));
    return reply.redirect('/account', 303);
  }

  function returnTo(request: FastifyRequest): string | undefined {
    const value = request.cookieValue(RETURN_COOKIE);
    if (!value) return undefined;
    try {
      return formActionOrigins.includes(new URL(value).origin) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/account',
    async (request, reply) => {
      const chosen = request.query[LANG_PARAM];
      const back = request.query.return_to;
      if (isLocale(chosen) || back !== undefined) {
        const cookies: string[] = [];
        if (isLocale(chosen)) {
          cookies.push(
            `${LOCALE_COOKIE}=${chosen}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`,
          );
        }
        let valid = false;
        try {
          valid = back !== undefined && formActionOrigins.includes(new URL(back).origin);
        } catch {
          valid = false;
        }
        if (valid) {
          cookies.push(
            `${RETURN_COOKIE}=${encodeURIComponent(back!)}; Path=/account; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`,
          );
        }
        reply.header('set-cookie', cookies);
        return reply.redirect('/account', 303);
      }
      const loc = locale(request);
      const user = await current(request);
      if (!user) return page(reply, 200, accountSigninPage({ locale: loc }));
      const on = await mfa.enabled(user.id);
      const m = MESSAGES[loc].account;
      const done = (request.query as Record<string, string | undefined>).done;
      return page(
        reply,
        200,
        accountPage({
          locale: loc,
          name: user.displayName,
          email: user.email,
          twoStep: on,
          recoveryLeft: on ? await mfa.remainingRecoveryCodes(user.id) : 0,
          events: await audit.forUser(user.id, 10),
          returnTo: returnTo(request),
          notice: done === 'off' ? m.disabledNotice : done === 'on' ? m.enabledNotice : undefined,
        }),
      );
    },
  );

  app.post<{ Body: { email?: string; password?: string } }>(
    '/account/signin',
    limited,
    async (request, reply) => {
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const loc = locale(request);
      const email = (request.body?.email ?? '').trim();
      const password = request.body?.password ?? '';
      const user = email && password ? await users.authenticate(email, password) : null;
      if (!user) {
        await audit.record('signin.failed', null, request.ip, { email, where: 'account' });
        return page(
          reply,
          401,
          accountSigninPage({
            locale: loc,
            email,
            error: email && password ? 'invalid' : 'missing',
          }),
        );
      }
      if (await mfa.enabled(user.id)) {
        const challenge = await mfa.createChallenge(user.id, 'account');
        return page(
          reply,
          200,
          secondStepPage({ locale: loc, action: '/account/second-step', challenge }),
        );
      }
      await audit.record('account.signed_in', user.id, request.ip);
      return signedIn(reply, user.id);
    },
  );

  app.post<{ Body: CodeBody }>('/account/second-step', limited, async (request, reply) => {
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const loc = locale(request);
    const id = request.body?.challenge ?? '';
    const challenge = id ? await mfa.challenge(id, 'account') : null;
    if (!challenge) {
      return page(
        reply,
        400,
        secondStepPage({ locale: loc, action: '/account/second-step', error: 'expired' }),
      );
    }
    const factor = await mfa.verify(challenge.userId, request.body?.code ?? '');
    if (!factor) {
      await audit.record('signin.second_step_failed', challenge.userId, request.ip, {
        where: 'account',
      });
      const left = await mfa.failAttempt(id);
      const error: CodeError = left > 0 ? { attemptsLeft: left } : 'expired';
      return page(
        reply,
        401,
        secondStepPage({ locale: loc, action: '/account/second-step', challenge: id, error }),
      );
    }
    await mfa.finishChallenge(id);
    if (factor === 'recovery')
      await audit.record('recovery_code.used', challenge.userId, request.ip);
    await audit.record('account.signed_in', challenge.userId, request.ip, { second_step: factor });
    return signedIn(reply, challenge.userId);
  });

  app.post('/account/signout', async (request, reply) => {
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const user = await current(request);
    if (user) await audit.record('account.signed_out', user.id, request.ip);
    reply.header('set-cookie', clearAccountCookie(secure));
    const loc = locale(request);
    return page(
      reply,
      200,
      accountSigninPage({ locale: loc, notice: MESSAGES[loc].account.signedOut }),
    );
  });

  // --- two-step verification --------------------------------------------------

  async function renderSetup(
    reply: FastifyReply,
    loc: Locale,
    user: { id: string; email: string },
    error?: CodeError,
  ) {
    const setup =
      (await mfa.pendingSecret(user.id, user.email)) ?? (await mfa.beginSetup(user.id, user.email));
    const qrSvg = await QRCode.toString(setup.uri, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return page(
      reply,
      error ? 401 : 200,
      setupPage({ locale: loc, secret: setup.secret, qrSvg, error }),
    );
  }

  app.get('/account/two-step/setup', async (request, reply) => {
    const user = await current(request);
    if (!user) return reply.redirect('/account', 303);
    if (await mfa.enabled(user.id)) return reply.redirect('/account', 303);
    return renderSetup(reply, locale(request), user);
  });

  app.post<{ Body: CodeBody }>('/account/two-step/setup', limited, async (request, reply) => {
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const user = await current(request);
    if (!user) return reply.redirect('/account', 303);
    if (await mfa.enabled(user.id)) return reply.redirect('/account', 303);
    const loc = locale(request);
    const codes = await mfa.confirmSetup(user.id, (request.body?.code ?? '').replace(/\s/g, ''));
    if (!codes) return renderSetup(reply, loc, user, 'invalid');
    await audit.record('two_step.enabled', user.id, request.ip);
    return page(reply, 200, recoveryCodesPage({ locale: loc, codes }));
  });

  function confirmPage(loc: Locale, kind: 'off' | 'codes', error?: CodeError) {
    const m = MESSAGES[loc].account;
    return kind === 'off'
      ? confirmWithCodePage({
          locale: loc,
          title: m.turnOffTitle,
          body: m.turnOffBody,
          confirm: m.turnOff,
          action: '/account/two-step/off',
          destructive: true,
          error,
        })
      : confirmWithCodePage({
          locale: loc,
          title: m.newCodesTitle,
          body: m.newCodesBody,
          confirm: m.newCodes,
          action: '/account/recovery-codes',
          error,
        });
  }

  for (const [path, kind] of [
    ['/account/two-step/off', 'off'],
    ['/account/recovery-codes', 'codes'],
  ] as const) {
    app.get(path, async (request, reply) => {
      const user = await current(request);
      if (!user || !(await mfa.enabled(user.id))) return reply.redirect('/account', 303);
      return page(reply, 200, confirmPage(locale(request), kind));
    });

    app.post<{ Body: CodeBody }>(path, limited, async (request, reply) => {
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const user = await current(request);
      if (!user || !(await mfa.enabled(user.id))) return reply.redirect('/account', 303);
      const loc = locale(request);
      const factor = await mfa.verify(user.id, request.body?.code ?? '');
      if (!factor) return page(reply, 401, confirmPage(loc, kind, 'invalid'));
      if (factor === 'recovery') await audit.record('recovery_code.used', user.id, request.ip);
      if (kind === 'off') {
        await mfa.disable(user.id);
        await audit.record('two_step.disabled', user.id, request.ip);
        return reply.redirect('/account?done=off', 303);
      }
      const codes = await mfa.regenerateRecoveryCodes(user.id);
      await audit.record('recovery_codes.regenerated', user.id, request.ip);
      return page(reply, 200, recoveryCodesPage({ locale: loc, codes }));
    });
  }
}
