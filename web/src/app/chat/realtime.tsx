// SPDX-License-Identifier: Apache-2.0
import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RealtimeClient } from '@cenacle/core/realtime';
import { useConnection } from './connection';
import { addMessage, reloadChannels, reloadMessages, type Message } from './data';
import { usePending } from './pending';

/**
 * Keeps the live connection open while signed in and applies its events to
 * the query cache.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const client = new RealtimeClient({
      onEvent(ev) {
        if (ev.type === 'message.created') {
          const message = ev.data as Message;
          addMessage(queryClient, message);
          // The sender's own pending copy is now confirmed.
          usePending.getState().remove(message.nonce);
        } else if (ev.type === 'channel.members_changed') {
          const { channel_id } = ev.data as { channel_id: string };
          void queryClient.invalidateQueries({ queryKey: ['members', channel_id] });
        } else if (ev.type.startsWith('channel.')) {
          void reloadChannels(queryClient);
        }
      },
      onResync() {
        void reloadMessages(queryClient);
        void reloadChannels(queryClient);
      },
      onStatus(status) {
        useConnection.setState({ status });
      },
      onUnauthenticated() {
        void queryClient.invalidateQueries({ queryKey: ['session'] });
      },
    });
    client.start();
    return () => client.stop();
  }, [queryClient]);

  return children;
}
