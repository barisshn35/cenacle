// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cached data shows instantly; refetch quietly in the background.
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
});
