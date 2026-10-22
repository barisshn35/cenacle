// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { isActive, notificationsQuery } from './notifications';

/** Channels and conversations the person muted (now). */
export function useMutedChannels(): Set<string> {
  const settings = useQuery(notificationsQuery);
  return new Set(
    (settings.data?.channels ?? []).filter((c) => isActive(c.muted_until)).map((c) => c.channel_id),
  );
}
