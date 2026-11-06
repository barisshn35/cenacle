// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '@cenacle/core/api';
import { describe, expect, it } from 'vitest';
import { shouldRetry } from './query-client';

const problem = (status: number) =>
  new ApiError({ type: 'about:blank', status, code: 'x', title: 'x' });

describe('shouldRetry', () => {
  it('does not ask again after a refusal', () => {
    for (const status of [400, 401, 403, 404, 409])
      expect(shouldRetry(0, problem(status))).toBe(false);
  });
  it('retries what may pass later, twice', () => {
    for (const status of [500, 503, 408, 429]) expect(shouldRetry(0, problem(status))).toBe(true);
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(2, problem(503))).toBe(false);
  });
});
