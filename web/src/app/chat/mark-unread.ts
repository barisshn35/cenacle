// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { inChannel, markUnread, type Message } from './data';
import { threadKey, useUnreadHold } from './unread-hold';

/**
 * Marks a message (and what follows it) unread. The channel or thread then
 * stays unread while it is open here.
 */
export function useMarkUnread(message: Message) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markUnread(message.channel_id, message.id),
    onMutate: () => {
      const { hold } = useUnreadHold.getState();
      if (message.root_id) hold(threadKey(message.root_id), { after: null, from: message.id });
      if (inChannel(message)) hold(message.channel_id, { after: null, from: message.id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success(t('chat.markedUnread'));
    },
    onError: () => {
      const { release } = useUnreadHold.getState();
      if (message.root_id) release(threadKey(message.root_id));
      if (inChannel(message)) release(message.channel_id);
      toast.error(t('chat.markUnreadFailed'));
    },
  });
}
