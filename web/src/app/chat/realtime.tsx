// SPDX-License-Identifier: Apache-2.0
import { useEffect, type ReactNode } from 'react';
import { useSession } from '../auth/session';
import { useQueryClient } from '@tanstack/react-query';
import { RealtimeClient } from '@cenacle/core/realtime';
import { useConnection } from './connection';
import { reloadWorkspaces } from './workspaces';
import { QuickSwitcher } from './quick-switcher';
import { useQuickSwitcherShortcut } from './quick-switcher-state';
import { useLive } from './presence-state';
import {
  addMessage,
  applyReaction,
  countIncoming,
  reloadChannels,
  reloadMessages,
  removeMessage,
  replaceMessage,
  setReadLocally,
  type Message,
  type PresenceStatus,
  type ReactionEvent,
} from './data';
import { usePending } from './pending';

/**
 * Keeps the live connection open while signed in and applies its events to
 * the query cache.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const selfId = useSession().user.id;

  useEffect(() => {
    const live = useLive.getState();
    const client = new RealtimeClient({
      onEvent(ev) {
        if (ev.type === 'message.created') {
          const message = ev.data as Message;
          addMessage(queryClient, message);
          if (message.files?.length) {
            void queryClient.invalidateQueries({ queryKey: ['files', message.channel_id] });
          }
          countIncoming(queryClient, message, selfId);
          live.stopTyping(message.channel_id, message.author.id);
          // The sender's own pending copy is now confirmed.
          usePending.getState().remove(message.nonce);
        } else if (ev.type === 'reaction.added' || ev.type === 'reaction.removed') {
          applyReaction(
            queryClient,
            ev.data as ReactionEvent,
            ev.type === 'reaction.added',
            selfId,
          );
        } else if (ev.type === 'channel.read') {
          const { channel_id, message_id } = ev.data as { channel_id: string; message_id: string };
          setReadLocally(queryClient, channel_id, message_id);
        } else if (ev.type === 'message.updated') {
          replaceMessage(queryClient, ev.data as Message);
        } else if (ev.type === 'message.deleted') {
          const ref = ev.data as Pick<Message, 'id' | 'channel_id'>;
          removeMessage(queryClient, ref);
          void queryClient.invalidateQueries({ queryKey: ['files', ref.channel_id] });
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
      onEphemeral(ev) {
        if (ev.type === 'typing') {
          const d = ev.data as { channel_id: string; user_id: string; display_name: string };
          live.startTyping(d.channel_id, d.user_id, d.display_name);
        } else if (ev.type === 'presence.changed') {
          const d = ev.data as { user_id: string; status: PresenceStatus };
          live.setPresence(d.user_id, d.status);
        }
      },
      onResync() {
        void reloadMessages(queryClient);
        void reloadChannels(queryClient);
        void queryClient.invalidateQueries({ queryKey: ['presence'] });
      },
      onStatus(status) {
        useConnection.setState({ status });
      },
      onUnauthenticated() {
        void queryClient.invalidateQueries({ queryKey: ['session'] });
      },
    });
    client.start();
    const expire = setInterval(() => live.expireTyping(), 1000);
    return () => {
      client.stop();
      clearInterval(expire);
    };
  }, [queryClient, selfId]);

  useQuickSwitcherShortcut();
  return (
    <>
      {children}
      <QuickSwitcher />
    </>
  );
}
