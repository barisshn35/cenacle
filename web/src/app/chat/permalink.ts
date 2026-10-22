// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useLayout } from '../../stores/layout';
import { inChannel, messageQuery } from './data';
import { useJump } from './jump';

/**
 * A link to a message (/c/<channel>?m=<message>) brings it into view: in the
 * channel, or in its thread for a reply. The parameter is then dropped.
 */
export function usePermalink(channelId: string | undefined): void {
  const { m } = useSearch({ strict: false }) as { m?: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!m || !channelId) return;
    void navigate({ to: '/c/$channelId', params: { channelId }, search: {}, replace: true });
    void queryClient
      .fetchQuery(messageQuery(queryClient, channelId, m))
      .then((message) => {
        if (inChannel(message)) {
          useJump.getState().jump({ channelId, messageId: message.id });
        } else {
          useLayout.getState().openThread({ channelId, rootId: message.root_id! });
          useJump.getState().done(message.id);
        }
      })
      .catch(() => undefined);
  }, [m, channelId, navigate, queryClient]);
}
