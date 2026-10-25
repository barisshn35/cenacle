// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session';
import type { Channel } from '../chat/data';
import { sync } from './mls';
import { restoreChannel } from './recovery';

/**
 * Keeps an MLS channel's group up to date on this device while it is open,
 * and brings its history backups here once.
 */
export function useMLSChannel(channel: Channel | undefined) {
  const selfId = useSession().user.id;
  const queryClient = useQueryClient();
  const id = channel?.mls ? channel.id : undefined;
  useEffect(() => {
    if (!id) return;
    let stop = false;
    void sync(id, selfId)
      .then(() => restoreChannel(selfId, id))
      .then((n) => {
        if (!stop && n > 0) void queryClient.invalidateQueries({ queryKey: ['mls-open', id] });
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [id, selfId, queryClient]);
}
