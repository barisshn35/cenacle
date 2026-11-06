// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ApiError } from '@cenacle/core/api';
import { errorKindFor } from '@cenacle/ui/lib/errors';
import { retrySearch } from './search';

const problem = (status: number, code: string) =>
  new ApiError({ type: 'about:blank', title: 'x', status, code });

describe('search errors', () => {
  it('does not retry a search the server stopped as too slow', () => {
    expect(retrySearch(0, problem(503, 'search_timeout'))).toBe(false);
  });

  it('retries other failures twice', () => {
    for (const e of [
      problem(503, 'service_unavailable'),
      problem(0, 'network_error'),
      new Error('x'),
    ]) {
      expect([0, 1, 2].map((n) => retrySearch(n, e))).toEqual([true, true, false]);
    }
  });

  it('shows the search texts for a search that took too long', () => {
    expect(errorKindFor({ status: 503, code: 'search_timeout' })).toBe('search_timeout');
  });
});
