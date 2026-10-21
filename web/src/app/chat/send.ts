// SPDX-License-Identifier: Apache-2.0
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ApiError, apiFetch } from '@cenacle/core/api';
import { addMessage, type Message } from './data';
import { newNonce, usePending, type PendingMessage } from './pending';

/**
 * Sends messages optimistically: the message shows at once as "sending",
 * becomes a normal message when the server confirms, or "failed" with a
 * retry. Retries reuse the nonce, so the server never stores it twice.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();

  const deliver = useCallback(
    async (p: Pick<PendingMessage, 'nonce' | 'channelId' | 'body'>) => {
      const { update, remove } = usePending.getState();
      update(p.nonce, { status: 'sending', retryAfter: undefined });
      try {
        const message = await apiFetch<Message>(`/api/channels/${p.channelId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: p.body, nonce: p.nonce }),
        });
        addMessage(queryClient, message);
        remove(p.nonce);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // The session ended: keep the message; RequireSession goes to sign-in.
          update(p.nonce, { status: 'failed' });
          void queryClient.invalidateQueries({ queryKey: ['session'] });
          return;
        }
        update(p.nonce, {
          status: 'failed',
          retryAfter: err instanceof ApiError ? err.retryAfter : undefined,
        });
      }
    },
    [queryClient],
  );

  const send = useCallback(
    (channelId: string, body: string, mentions: PendingMessage['mentions'] = []) => {
      const pending: PendingMessage = {
        nonce: newNonce(),
        channelId,
        body,
        mentions,
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
