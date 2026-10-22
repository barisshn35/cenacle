// SPDX-License-Identifier: AGPL-3.0-only
import { MessageSquareIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { useLayout } from '../../stores/layout';
import type { Message } from '../chat/data';

/** On a message: reply in its thread (a reply's own thread). */
export function ReplyButton({ message }: { message: Message }) {
  const { t } = useTranslation();
  const openThread = useLayout((s) => s.openThread);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('threads.reply')}
      onClick={() =>
        openThread({ channelId: message.channel_id, rootId: message.root_id ?? message.id })
      }
      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    >
      <MessageSquareIcon strokeWidth={1.75} />
    </Button>
  );
}
