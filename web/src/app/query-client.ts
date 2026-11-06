// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@cenacle/core/api';

/** Retries what may pass a moment later (network, 5xx, 408, 429), not a refusal. */
export function shouldRetry(failures: number, error: unknown): boolean {
  if (failures >= 2) return false;
  if (!(error instanceof ApiError)) return true;
  const status = error.problem.status;
  return status >= 500 || status === 408 || status === 429;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cached data shows instantly; refetch quietly in the background.
      staleTime: 30_000,
      retry: shouldRetry,
      refetchOnWindowFocus: true,
    },
  },
});
