// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyRequest } from 'fastify';

/** Remembers the language chosen on a Cenacle ID page. */
export const LOCALE_COOKIE = 'cenacle_id_locale';

/**
 * Headers for HTML pages. Everything is served from our own origin; forms may
 * only post to us, and the redirects that follow a sign-in may only reach the
 * registered client origins (browsers apply form-action to redirects too).
 */
export function pageSecurityHeaders(formActionOrigins: string[]): Record<string, string> {
  const formAction = ["'self'", ...formActionOrigins].join(' ');
  return {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      // Passkeys: the pages fetch their WebAuthn options from us.
      "connect-src 'self'",
      `form-action ${formAction}`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    // same-origin (not no-referrer): browsers then send our Origin with form posts.
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cache-control': 'no-store',
  };
}

/**
 * Rejects cross-site form posts. Sec-Fetch-Site (sent by every current
 * browser) must say same-origin; an Origin header, when it carries a real
 * origin, must be ours. "Origin: null" (privacy contexts) is decided by
 * Sec-Fetch-Site alone; with neither header the request is rejected.
 */
export function isSameOriginPost(request: FastifyRequest, issuer: string): boolean {
  const ours = new URL(issuer).origin;
  const site = request.headers['sec-fetch-site'];
  const origin = request.headers.origin;
  if (site !== undefined && site !== 'same-origin') return false;
  if (origin !== undefined && origin !== 'null' && origin !== ours) return false;
  return site === 'same-origin' || (origin !== undefined && origin === ours);
}
