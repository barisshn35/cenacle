// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';
import { queryOptions } from '@tanstack/react-query';
import { getSession, isUnauthenticated, type Session } from '@cenacle/core/api';

/** The current session. A 401 is an answer ("signed out"), not a failure to retry. */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: getSession,
  staleTime: 60_000,
  retry: (failures, err) => !isUnauthenticated(err) && failures < 2,
  // Quick retries: the app cannot show anything without this answer.
  retryDelay: (attempt) => 300 * 2 ** attempt,
  // The router already waited for this query; show its error instead of
  // starting over when RequireSession mounts.
  retryOnMount: false,
});

export const SessionContext = createContext<Session | null>(null);

/** Session of the signed-in user; only inside the authenticated part of the app. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside of <RequireSession>');
  return session;
}

/** Sign-in outcomes shown on /signin (set by the server or by the app). */
export const SIGNIN_ERRORS = [
  'cancelled',
  'expired',
  'failed',
  'unavailable',
  'session_expired',
] as const;
export type SigninError = (typeof SIGNIN_ERRORS)[number];

export interface SigninSearch {
  error?: SigninError;
  return_to?: string;
}

export function validateSigninSearch(s: Record<string, unknown>): SigninSearch {
  return {
    error: SIGNIN_ERRORS.includes(s.error as SigninError) ? (s.error as SigninError) : undefined,
    return_to: typeof s.return_to === 'string' ? s.return_to : undefined,
  };
}

/** Search of /signin that returns to `href` afterwards. */
export function signinSearchFor(href: string, error?: SigninError): SigninSearch {
  return { error, return_to: href === '/' ? undefined : href };
}
