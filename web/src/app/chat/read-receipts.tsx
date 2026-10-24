// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { CheckCheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useActiveWorkspace } from './active-workspace';
import { isConversation, readsQuery, type Channel, type Message } from './data';

/**
 * "Seen" under one's newest message in a conversation, where the workspace
 * turned read receipts on: who has read it (or answered since).
 */
export function SeenBy({
  channel,
  message,
  repliers,
}: {
  channel: Channel;
  message: Message;
  /** Others who wrote after it (they have seen it). */
  repliers: string[];
}) {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const on = !!workspace?.read_receipts && isConversation(channel);
  const reads = useQuery(readsQuery(channel.id, on));
  if (!on || !reads.data?.enabled) return null;
  const others = channel.participants;
  const seen = others.filter(
    (p) =>
      repliers.includes(p.id) ||
      reads.data.reads.some(
        (r) => r.user_id === p.id && r.last_read_id !== null && r.last_read_id >= message.id,
      ),
  );
  if (seen.length === 0) return null;
  const text =
    channel.kind === 'direct'
      ? t('receipts.seen')
      : seen.length === others.length
        ? t('receipts.seenByAll')
        : t('receipts.seenBy', { names: seen.map((p) => p.display_name).join(', ') });
  return (
    <p
      className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"
      data-testid="seen-by"
    >
      <CheckCheckIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {text}
    </p>
  );
}
