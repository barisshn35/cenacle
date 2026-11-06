// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type pg from 'pg';
import type { AuditLog } from '../accounts/audit.ts';
import { EXPORT_HEADERS, exportAccount, toNdjson } from '../accounts/privacy.ts';
import type { MfaStore } from '../accounts/mfa.ts';
import type { PasskeyStore } from '../accounts/passkeys.ts';
import {
  checkPasskey,
  checkPassword,
  usernamesAllowed,
  type DirectoryAccess,
} from '../accounts/signin.ts';
import type { UserStore } from '../accounts/users.ts';
import { FEDERATION_COOKIE, federationCookie } from '../federation/routes.ts';
import { DEFAULT_POLICY, type PolicyStore, type SignInPolicy } from '../accounts/policy.ts';
import type { ProviderStore } from '../federation/store.ts';
import { isSameOriginPost, LOCALE_COOKIE, pageSecurityHeaders } from '../oidc/security.ts';
import { isLocale, MESSAGES, pickLocale, type Locale } from '../ui/messages.ts';
import {
  accountPage,
  accountSigninPage,
  confirmWithCodePage,
  continuePage,
  LANG_PARAM,
  recoveryCodesPage,
  secondStepPage,
  setupPage,
  type CodeError,
} from '../ui/pages.ts';
import {
  accountCookie,
  ACCOUNT_COOKIE,
  accountUser,
  clearAccountCookie,
  signAccount,
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
  directory?: DirectoryAccess;
  passkeys?: PasskeyStore;
  federation?: ProviderStore;
  /** The sign-in policy (v0.29); without it, two-step is optional and passkeys allowed. */
  policy?: PolicyStore;
  /** The database, for "Download my data"; without it, it is not offered. */
  pool?: pg.Pool;
}

type CodeBody = { code?: string; challenge?: string };

/**
 * The account pages (/account): sign in with password and second step, turn
 * two-step verification on and off, new recovery codes, recent activity.
 */
export async function registerAccount(app: FastifyInstance, opts: AccountOptions) {
  /** The sign-in policy; without a store, the behaviour before v0.29. */
  const policy = async (): Promise<SignInPolicy> =>
    opts.policy
      ? await opts.policy.get()
      : { ...DEFAULT_POLICY, requireTwoStep: false, passkeys: true };
  const passkeysOff = async () => !opts.passkeys || !(await policy()).passkeys;

  const { users, mfa, audit, issuer, cookieKeys, formActionOrigins } = opts;
  const secure = new URL(issuer).protocol === 'https:';
  const limited = { config: { rateLimit: { max: opts.rateLimit ?? 10, timeWindow: '1 minute' } } };

  const providers = async () => (opts.federation ? await opts.federation.enabled() : []);

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
    return accountUser(users, cookieKeys, request.cookieValue(ACCOUNT_COOKIE));
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
      if (!user)
        return page(
          reply,
          200,
          accountSigninPage({
            locale: loc,
            usernames: await usernamesAllowed(opts.directory),
            providers: await providers(),
            passkeys: (await policy()).passkeys,
            error: request.query.federation_error ? 'federation' : undefined,
          }),
        );
      const on = await mfa.enabled(user.id);
      const rules = await policy();
      // Required by the policy and not set up yet: setting it up comes first.
      if (rules.requireTwoStep && !on && !user.fromProvider) {
        return reply.redirect('/account/two-step/setup', 303);
      }
      const m = MESSAGES[loc].account;
      const done = (request.query as Record<string, string | undefined>).done;
      const notices: Record<string, string> = {
        off: m.disabledNotice,
        on: m.enabledNotice,
        'passkey-added': m.passkeyAdded,
        'passkey-removed': m.passkeyRemoved,
        name: m.nameSaved,
      };
      const failed = request.query.passkey_error;
      return page(
        reply,
        200,
        accountPage({
          locale: loc,
          name: user.displayName,
          email: user.email ?? user.username ?? '',
          twoStep: on,
          recoveryLeft: on ? await mfa.remainingRecoveryCodes(user.id) : 0,
          events: await audit.forUser(user.id, 10),
          returnTo: returnTo(request),
          isAdmin: user.isAdmin,
          notice: done ? notices[done] : undefined,
          passkeys: opts.passkeys ? await opts.passkeys.list(user.id) : [],
          passkeyError: failed === 'limit' || failed === 'failed' ? failed : undefined,
          nameEditable: !user.fromDirectory && !user.fromProvider,
          nameInvalid: request.query.name_error !== undefined,
          twoStepRequired: rules.requireTwoStep,
          passkeysAllowed: rules.passkeys,
          dataExport: opts.pool !== undefined,
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
      const result =
        email && password
          ? await checkPassword(users, opts.directory, email, password, (err) =>
              request.log.warn({ err }, 'directory sign-in failed'),
            )
          : null;
      const user = result && 'user' in result ? result.user : null;
      if (!user) {
        const failedFor = result && 'userId' in result ? (result.userId ?? null) : null;
        await audit.record('signin.failed', failedFor, request.ip, { email, where: 'account' });
        return page(
          reply,
          401,
          accountSigninPage({
            passkeys: (await policy()).passkeys,
            locale: loc,
            email,
            error: result && 'error' in result ? result.error : 'missing',
            usernames: await usernamesAllowed(opts.directory),
            providers: await providers(),
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
    const challenge = id ? await mfa.takeAttempt(id, 'account') : null;
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
      const left = challenge.attemptsLeft;
      const error: CodeError = left > 0 ? { attemptsLeft: left } : 'expired';
      return page(
        reply,
        401,
        secondStepPage({ locale: loc, action: '/account/second-step', challenge: id, error }),
      );
    }
    await mfa.passed(challenge);
    await mfa.finishChallenge(id);
    if (factor === 'recovery')
      await audit.record('recovery_code.used', challenge.userId, request.ip);
    await audit.record('account.signed_in', challenge.userId, request.ip, { second_step: factor });
    return signedIn(reply, challenge.userId);
  });

  // A person's data as one file (GDPR, KVKK), a few times an hour at most.
  app.post(
    '/account/data',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      if (!opts.pool) return reply.code(404).send();
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const user = await current(request);
      if (!user) return reply.redirect('/account', 303);
      const items = await exportAccount(opts.pool, user.id);
      if (!items) return reply.redirect('/account', 303);
      await audit.record('account.data_exported', user.id, request.ip);
      return reply.headers(EXPORT_HEADERS).send(toNdjson(items));
    },
  );

  app.post<{ Body: { name?: string } }>('/account/name', async (request, reply) => {
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const user = await current(request);
    if (!user) return reply.redirect('/account', 303);
    const name = (request.body?.name ?? '').replace(/\s+/g, ' ').trim();
    if (
      !name ||
      name.length > 100 ||
      [...name].some((c) => c.charCodeAt(0) < 32 || c === '\u007f')
    ) {
      return reply.redirect('/account?name_error=1', 303);
    }
    if (await users.setDisplayName(user.id, name)) {
      await audit.record('account.name_changed', user.id, request.ip);
    }
    return reply.redirect('/account?done=name', 303);
  });

  // --- identity providers ---------------------------------------------------

  app.get<{ Querystring: { state?: string } }>('/account/federated', async (request, reply) => {
    if (!opts.federation) return reply.code(404).send();
    const userId = await opts.federation.finish(
      request.query.state ?? '',
      request.cookieValue(FEDERATION_COOKIE),
      'account',
      null,
    );
    const user = userId ? await users.findById(userId) : null;
    if (!user || user.disabled) return reply.redirect('/account?federation_error=1', 303);
    await audit.record('account.signed_in', user.id, request.ip, { method: 'federation' });
    reply.header('set-cookie', [
      accountCookie(signAccount(cookieKeys, user.id), secure),
      federationCookie('', secure, 0),
    ]);
    return page(reply, 200, continuePage({ locale: locale(request), to: '/account' }));
  });

  // --- passkeys -------------------------------------------------------------

  app.post('/account/passkey/options', limited, async (request, reply) => {
    if (!opts.passkeys || (await passkeysOff())) return reply.code(404).send();
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    return reply
      .header('cache-control', 'no-store')
      .send(await opts.passkeys.authenticationOptions('account'));
  });

  app.post<{ Body: { challenge?: string; response?: string } }>(
    '/account/passkey',
    limited,
    async (request, reply) => {
      if (!opts.passkeys || (await passkeysOff())) return reply.code(404).send();
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const result = await checkPasskey(users, opts.passkeys, 'account', request.body);
      if (!result) {
        await audit.record('signin.passkey_failed', null, request.ip, { where: 'account' });
        return page(
          reply,
          401,
          accountSigninPage({
            passkeys: (await policy()).passkeys,
            locale: locale(request),
            error: 'passkey',
            usernames: await usernamesAllowed(opts.directory),
            providers: await providers(),
          }),
        );
      }
      // A passkey is two factors on its own: no second step.
      await audit.record('account.signed_in', result.user.id, request.ip, { method: 'passkey' });
      return signedIn(reply, result.user.id);
    },
  );

  app.post('/account/passkeys/options', limited, async (request, reply) => {
    if (!opts.passkeys || (await passkeysOff())) return reply.code(404).send();
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const user = await current(request);
    if (!user) return reply.code(401).send();
    return reply
      .header('cache-control', 'no-store')
      .send(await opts.passkeys.registrationOptions(user));
  });

  app.post<{ Body: { challenge?: string; response?: string; name?: string } }>(
    '/account/passkeys',
    limited,
    async (request, reply) => {
      if (!opts.passkeys || (await passkeysOff())) return reply.code(404).send();
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const user = await current(request);
      if (!user) return reply.redirect('/account', 303);
      let response: unknown;
      try {
        response = JSON.parse(request.body?.response ?? '');
      } catch {
        response = null;
      }
      const outcome =
        typeof response === 'object' && response !== null
          ? await opts.passkeys.register(
              user.id,
              request.body?.challenge ?? '',
              response as Parameters<PasskeyStore['register']>[2],
              request.body?.name ?? '',
            )
          : 'invalid';
      if (outcome !== 'ok') {
        return reply.redirect(
          `/account?passkey_error=${outcome === 'limit' ? 'limit' : 'failed'}`,
          303,
        );
      }
      await audit.record('passkey.added', user.id, request.ip, {
        name: (request.body?.name ?? '').trim().slice(0, 80),
      });
      return reply.redirect('/account?done=passkey-added', 303);
    },
  );

  app.post<{ Params: { id: string } }>('/account/passkeys/:id/delete', async (request, reply) => {
    if (!opts.passkeys || (await passkeysOff())) return reply.code(404).send();
    if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
    const user = await current(request);
    if (!user) return reply.redirect('/account', 303);
    if (await opts.passkeys.remove(user.id, request.params.id)) {
      await audit.record('passkey.removed', user.id, request.ip);
    }
    return reply.redirect('/account?done=passkey-removed', 303);
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
      accountSigninPage({
        passkeys: (await policy()).passkeys,
        locale: loc,
        notice: MESSAGES[loc].account.signedOut,
        usernames: await usernamesAllowed(opts.directory),
        providers: await providers(),
      }),
    );
  });

  // --- two-step verification --------------------------------------------------

  async function renderSetup(
    reply: FastifyReply,
    loc: Locale,
    user: { id: string; email: string | null; username: string | null; displayName: string },
    error?: CodeError,
  ) {
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
      if (kind === 'off' && (await policy()).requireTwoStep) return reply.redirect('/account', 303);
      return page(reply, 200, confirmPage(locale(request), kind));
    });

    app.post<{ Body: CodeBody }>(path, limited, async (request, reply) => {
      if (!isSameOriginPost(request, issuer)) return reply.code(403).send();
      const user = await current(request);
      if (!user || !(await mfa.enabled(user.id))) return reply.redirect('/account', 303);
      if (kind === 'off' && (await policy()).requireTwoStep) return reply.redirect('/account', 303);
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
