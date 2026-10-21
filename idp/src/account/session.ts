// SPDX-License-Identifier: Apache-2.0
import { createHmac } from 'node:crypto';
import { safeEqual } from '../accounts/mfa.ts';

/** Cookie of the account pages (separate from the OIDC session). */
export const ACCOUNT_COOKIE = 'cenacle_id_account';
/** The account pages need a fresh sign-in after this long. */
export const ACCOUNT_TTL_SECONDS = 30 * 60;

function mac(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/**
 * A signed, short-lived value naming the signed-in user: `<sub>.<exp>.<mac>`.
 * Signed with the first cookie key, accepted with any (key rotation).
 */
export function signAccount(keys: string[], sub: string, now = Date.now()): string {
  const payload = `${sub}.${Math.floor(now / 1000) + ACCOUNT_TTL_SECONDS}`;
  return `${payload}.${mac(keys[0]!, payload)}`;
}

/** The user id of a valid, unexpired cookie value, or null. */
export function verifyAccount(
  keys: string[],
  value: string | undefined,
  now = Date.now(),
): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [sub, exp, sig] = parts as [string, string, string];
  const payload = `${sub}.${exp}`;
  if (!keys.some((k) => safeEqual(mac(k, payload), sig))) return null;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 <= now) return null;
  return sub;
}

export function accountCookie(value: string, secure: boolean): string {
  return `${ACCOUNT_COOKIE}=${value}; Path=/account; Max-Age=${ACCOUNT_TTL_SECONDS}; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
}

export function clearAccountCookie(secure: boolean): string {
  return `${ACCOUNT_COOKIE}=; Path=/account; Max-Age=0; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
}
