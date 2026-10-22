// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
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
import { applyLinkPreview, revealMessage } from '../richer/richer';
import { profileChanged } from '../profile/profiles';
import {
  applyPoll,
  applyRun,
  bannerQuery,
  termsQuery,
  type Poll,
  type Run,
} from '../community/community';
import {
  applySaved,
  applyThreadUpdated,
  threadsChanged,
  type SavedItem,
  type ThreadSummary,
} from '../threads/threads';
import { notifyIncoming } from '../notifications/notifier';

/**
 * Keeps the live connection open while signed in and applies its events to
 * the query cache.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const selfId = useSession().user.id;
  // The latest navigate, without restarting the connection when it changes.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    const live = useLive.getState();
    const client = new RealtimeClient({
      onEvent(ev) {
        if (ev.type === 'message.created') {
          const message = ev.data as Message;
          // One's own burn-on-read message comes without its text: fetch it.
          if (message.burn?.hidden && message.author.id === selfId) {
            void revealMessage(message)
              .then((m) => addMessage(queryClient, m))
              .catch(() => undefined);
          } else {
            addMessage(queryClient, message);
          }
          if (message.files?.length) {
            void queryClient.invalidateQueries({ queryKey: ['files', message.channel_id] });
          }
          countIncoming(queryClient, message, selfId);
          // A reply: followed threads may have something new.
          if (message.root_id && message.author.id !== selfId) threadsChanged(queryClient);
          notifyIncoming(queryClient, message, selfId, (channelId) => {
            void navigateRef.current({ to: '/c/$channelId', params: { channelId } });
          });
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
          const message = ev.data as Message;
          replaceMessage(queryClient, message);
          void queryClient.invalidateQueries({ queryKey: ['pins', message.channel_id] });
        } else if (ev.type === 'message.preview') {
          applyLinkPreview(queryClient, ev.data as Parameters<typeof applyLinkPreview>[1]);
        } else if (ev.type === 'emoji.changed') {
          const { workspace_id } = ev.data as { workspace_id: string };
          void queryClient.invalidateQueries({ queryKey: ['custom-emoji', workspace_id] });
          void queryClient.invalidateQueries({ queryKey: ['stickers', workspace_id] });
        } else if (ev.type === 'message.deleted') {
          const ref = ev.data as Pick<Message, 'id' | 'channel_id'>;
          removeMessage(queryClient, ref);
          void queryClient.invalidateQueries({ queryKey: ['files', ref.channel_id] });
        } else if (ev.type === 'thread.updated') {
          applyThreadUpdated(
            queryClient,
            ev.data as { channel_id: string; root_id: string; thread: ThreadSummary | null },
          );
        } else if (ev.type === 'thread.followed' || ev.type === 'thread.read') {
          const { root_id } = ev.data as { root_id: string };
          void queryClient.invalidateQueries({ queryKey: ['thread-follow', root_id] });
          threadsChanged(queryClient);
        } else if (ev.type === 'saved.changed') {
          const d = ev.data as { message_id: string; item: SavedItem | null };
          applySaved(queryClient, d.message_id, d.item);
        } else if (ev.type === 'poll.updated') {
          applyPoll(
            queryClient,
            ev.data as { channel_id: string; message_id: string; user_id: string; poll: Poll },
            selfId,
          );
        } else if (ev.type === 'run.updated') {
          applyRun(queryClient, (ev.data as { run: Run }).run);
        } else if (ev.type === 'report.created') {
          const { workspace_id } = ev.data as { workspace_id: string };
          void queryClient.invalidateQueries({ queryKey: ['reports', workspace_id] });
        } else if (ev.type === 'event.changed') {
          const { workspace_id } = ev.data as { workspace_id: string };
          void queryClient.invalidateQueries({ queryKey: ['events', workspace_id] });
        } else if (ev.type === 'banner.changed') {
          void queryClient.invalidateQueries({ queryKey: bannerQuery.queryKey });
        } else if (ev.type === 'terms.changed') {
          void queryClient.invalidateQueries({ queryKey: termsQuery.queryKey });
        } else if (ev.type === 'categories.changed') {
          void queryClient.invalidateQueries({ queryKey: ['categories'] });
          void reloadChannels(queryClient);
        } else if (ev.type === 'user.updated') {
          const { user_id } = ev.data as { user_id: string };
          void profileChanged(queryClient, user_id, selfId);
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
