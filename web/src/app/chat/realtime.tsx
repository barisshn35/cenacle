// SPDX-License-Identifier: Apache-2.0
import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RealtimeClient } from '@cenacle/core/realtime';
import { useConnection } from './connection';
import { reloadWorkspaces } from './workspaces';
import { QuickSwitcher } from './quick-switcher';
import { useQuickSwitcherShortcut } from './quick-switcher-state';
import {
  addMessage,
  reloadChannels,
  reloadMessages,
  removeMessage,
  replaceMessage,
  type Message,
} from './data';
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
        } else if (ev.type === 'message.updated') {
          replaceMessage(queryClient, ev.data as Message);
        } else if (ev.type === 'message.deleted') {
          removeMessage(queryClient, ev.data as Pick<Message, 'id' | 'channel_id'>);
        } else if (ev.type === 'categories.changed') {
          void queryClient.invalidateQueries({ queryKey: ['categories'] });
          void reloadChannels(queryClient);
        } else if (ev.type === 'workspace.members_changed') {
          const { workspace_id } = ev.data as { workspace_id: string };
          void queryClient.invalidateQueries({ queryKey: ['workspace-members', workspace_id] });
        } else if (ev.type.startsWith('workspace.')) {
          void reloadWorkspaces(queryClient);
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

  useQuickSwitcherShortcut();
  return (
    <>
      {children}
      <QuickSwitcher />
    </>
  );
}
