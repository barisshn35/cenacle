// SPDX-License-Identifier: AGPL-3.0-only
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ApiError, apiFetch } from '@cenacle/core/api';
import { sealFor } from '../compliance/e2e';
import { addMessage, type Message } from './data';
import { newNonce, usePending, type PendingMessage } from './pending';
import { threadKey, useUnreadHold } from './unread-hold';

/**
 * Sends messages optimistically: the message shows at once as "sending",
 * becomes a normal message when the server confirms, or "failed" with a
 * retry. Retries reuse the nonce, so the server never stores it twice.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();

  const deliver = useCallback(
    async (
      p: Pick<
        PendingMessage,
        | 'nonce'
        | 'channelId'
        | 'body'
        | 'files'
        | 'rootId'
        | 'alsoInChannel'
        | 'sticker'
        | 'burnSeconds'
        | 'priority'
      >,
    ) => {
      const { update, remove } = usePending.getState();
      update(p.nonce, { status: 'sending', retryAfter: undefined, reason: undefined });
      try {
        const message = await apiFetch<Message>(`/api/channels/${p.channelId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Encrypted channels get the body sealed with their key.
            body: await sealFor(p.channelId, p.body),
            nonce: p.nonce,
            ...(p.files?.length ? { file_ids: p.files.map((f) => f.id) } : {}),
            ...(p.rootId ? { root_id: p.rootId, also_in_channel: !!p.alsoInChannel } : {}),
            ...(p.sticker ? { sticker_id: p.sticker.id } : {}),
            ...(p.burnSeconds ? { burn_seconds: p.burnSeconds } : {}),
            ...(p.priority?.level ? { priority: p.priority.level } : {}),
            ...(p.priority?.requestAck ? { request_ack: true } : {}),
            ...(p.priority?.persistent ? { persistent: true } : {}),
          }),
        });
        addMessage(queryClient, message);
        // Sending reads what was marked unread there (as on the server).
        useUnreadHold.getState().release(message.channel_id);
        // Replying makes one follow the thread (on the server).
        if (message.root_id) {
          useUnreadHold.getState().release(threadKey(message.root_id));
          void queryClient.invalidateQueries({ queryKey: ['thread-follow', message.root_id] });
        }
        remove(p.nonce);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // The session ended: keep the message; RequireSession goes to sign-in.
          update(p.nonce, { status: 'failed' });
          void queryClient.invalidateQueries({ queryKey: ['session'] });
          return;
        }
        const moderated =
          err instanceof ApiError &&
          [
            'automod_blocked',
            'timed_out',
            'slow_mode',
            'broadcast_not_allowed',
            'read_only_channel',
          ].includes(err.problem.code ?? '');
        update(p.nonce, {
          status: 'failed',
          retryAfter: err instanceof ApiError ? err.retryAfter : undefined,
          reason: moderated ? (err as ApiError).problem.detail : undefined,
        });
      }
    },
    [queryClient],
  );

  const send = useCallback(
    (
      channelId: string,
      body: string,
      mentions: PendingMessage['mentions'] = [],
      files: PendingMessage['files'] = [],
      reply?: { rootId: string; alsoInChannel: boolean },
      extra: Pick<PendingMessage, 'sticker' | 'burnSeconds' | 'priority'> = {},
    ) => {
      const pending: PendingMessage = {
        nonce: newNonce(),
        channelId,
        body,
        mentions,
        files,
        rootId: reply?.rootId,
        alsoInChannel: reply?.alsoInChannel,
        ...extra,
        status: 'sending',
        createdAt: Date.now(),
      };
      usePending.getState().add(pending);
      void deliver(pending);
    },
    [deliver],
  );

  return { send, retry: deliver, discard: usePending.getState().remove };
}
