// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A notice people accept before they sign in (DISA STIG: the notice and
 * consent banner). With IDP_SIGNIN_NOTICE set, every way to sign in (an app's
 * sign-in, the account pages, passkeys, other providers) shows the notice
 * first; accepting it is remembered for the browser session.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isSameOriginPost, LOCALE_COOKIE, pageSecurityHeaders } from '../oidc/security.ts';
import { html } from './html.ts';
import { MESSAGES, pickLocale, type Locale } from './messages.ts';
import { layout } from './pages.ts';

export const NOTICE_COOKIE = 'cenacle_notice';

/**
 * Routes that lead to signing in, matched on the route pattern Fastify chose
 * (not the raw URL, so `/account/%73ignin` cannot slip past): every step of
 * an app's sign-in and every way to sign in to the account pages.
 */
const GATED_ROUTES = new Set([
  '/account',
  '/account/signin',
  '/account/second-step',
  '/account/passkey/options',
  '/account/passkey',
  '/federation/:id/start',
]);

function gated(route: string | undefined): boolean {
  if (!route) return false;
  return (
    GATED_ROUTES.has(route) ||
    route === '/interaction/:uid' ||
    route.startsWith('/interaction/:uid/')
  );
}
/** Where accepting may go back to (a page, not an action). */
const RETURN = /^\/(interaction\/[A-Za-z0-9_-]+|account)$/;

const primary =
  'inline-flex min-h-target h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-primary px-4 text-[15.5px] font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50';

export function noticePage(locale: Locale, text: string, next: string): string {
  const m = MESSAGES[locale].notice;
  return layout({
    locale,
    title: m.title,
    body: html`<div>
        <h1 class="text-[34px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance">
          ${m.title}
        </h1>
      </div>
      <div
        class="rounded-[10px] border border-rule-strong bg-background p-4 text-[15px] leading-[1.55] whitespace-pre-line"
        data-testid="signin-notice"
      >
        ${text}
      </div>
      <form method="post" action="/notice" class="flex flex-col gap-3">
        <input type="hidden" name="next" value="${next}" />
        <button type="submit" class="${primary}">${m.accept}</button>
      </form>`,
  });
}

export function registerSigninNotice(
  app: FastifyInstance,
  opts: { text: string; issuer: string; formActionOrigins: string[] },
) {
  const secure = new URL(opts.issuer).protocol === 'https:';
  const locale = (request: FastifyRequest) =>
    pickLocale(request.cookieValue(LOCALE_COOKIE), request.headers['accept-language']);
  const page = (reply: FastifyReply, status: number, body: string) =>
    reply
      .code(status)
      .headers(pageSecurityHeaders(opts.formActionOrigins))
      .type('text/html; charset=utf-8')
      .send(body);

  app.addHook('preHandler', async (request, reply) => {
    if (!gated(request.routeOptions.url) || request.cookieValue(NOTICE_COOKIE) === 'accepted') {
      return;
    }
    if (request.method === 'GET') {
      // Back to the page this sign-in started from once the notice is accepted.
      const uid = (request.params as { uid?: string } | undefined)?.uid;
      const next = uid === undefined ? '/account' : `/interaction/${uid}`;
      return page(
        reply,
        200,
        noticePage(locale(request), opts.text, RETURN.test(next) ? next : '/account'),
      );
    }
    // An action that skipped the notice (a passkey, a form posted directly).
    return page(reply, 403, noticePage(locale(request), opts.text, '/account'));
  });

  app.post<{ Body: { next?: string } }>('/notice', async (request, reply) => {
    if (!isSameOriginPost(request, opts.issuer)) return reply.code(403).send();
    const next = request.body?.next ?? '';
    reply.header(
      'set-cookie',
      `${NOTICE_COOKIE}=accepted; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    return reply.redirect(RETURN.test(next) ? next : '/account', 303);
  });
}
