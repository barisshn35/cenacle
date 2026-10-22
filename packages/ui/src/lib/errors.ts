// SPDX-License-Identifier: AGPL-3.0-only

/** Error kinds with localized texts under `ui:errors.<kind>`. */
export type ErrorKind =
  | 'server_error'
  | 'network_error'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'session_expired'
  | 'service_unavailable';

const KNOWN: ReadonlySet<string> = new Set<ErrorKind>([
  'server_error',
  'network_error',
  'forbidden',
  'not_found',
  'rate_limited',
  'session_expired',
  'service_unavailable',
]);

/** Subset of an RFC 9457 problem (application/problem+json) as returned by Cenacle APIs. */
export interface ProblemLike {
  status?: number;
  code?: string;
  request_id?: string;
}

/** Maps a problem's code or HTTP status to an error kind with localized texts. */
export function errorKindFor(problem: ProblemLike): ErrorKind {
  if (problem.code && KNOWN.has(problem.code)) return problem.code as ErrorKind;
  switch (problem.status) {
    case undefined:
    case 0:
      return 'network_error';
    case 401:
      return 'session_expired';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    case 503:
      return 'service_unavailable';
    default:
      return 'server_error';
  }
}
