// SPDX-License-Identifier: AGPL-3.0-only
import { LogInIcon, LogOutIcon, UserMinusIcon, UserPlusIcon } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { profileQuery } from '../profile/profiles';
import type { ChannelLine } from './data';
import type { Row, useFormatters } from './rows';

const ICON = { joined: LogInIcon, left: LogOutIcon, added: UserPlusIcon, removed: UserMinusIcon };

/** A person's current name; an erased person has none. */
function useName(id: string | undefined) {
  const { t } = useTranslation();
  const query = useQuery({ ...profileQuery(id ?? ''), enabled: Boolean(id) });
  if (query.isPending) return '…';
  return query.data?.display_name ?? t('chat.lines.someone');
}

/**
 * "Ada joined", "Can was added by Ada": a quiet line in the timeline, set
 * in the words column, its icon in the margin. Never unread, never a
 * notification; the icon only repeats what the words say.
 */
export function ChannelLineRow({
  row,
  line,
  fmt,
  grid,
}: {
  row: Extract<Row, { kind: 'message' }>;
  line: ChannelLine;
  fmt: ReturnType<typeof useFormatters>;
  grid: string;
}) {
  const { t } = useTranslation();
  const user = useName(line.user_id);
  const actor = useName(line.actor_id);
  const at = new Date(row.message.created_at);
  const Icon = ICON[line.kind];
  const key =
    line.actor_id && (line.kind === 'added' || line.kind === 'removed')
      ? `chat.lines.${line.kind}By`
      : `chat.lines.${line.kind}`;
  return (
    <div>
      {row.day && (
        <div role="separator" aria-label={row.day} className={cn(grid, 'pt-4 pb-1')}>
          <span aria-hidden />
          <span
            aria-hidden
            className="border-b border-border pb-1.5 text-sm font-semibold text-foreground"
          >
            {row.day}
          </span>
        </div>
      )}
      <p
        data-testid="channel-line"
        data-message-id={row.message.id}
        className={cn(grid, 'items-center py-1 text-[13px] text-muted-foreground')}
      >
        <span className="flex justify-center max-sm:hidden">
          <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
        </span>
        <span className="min-w-0">
          <Trans
            t={t}
            i18nKey={key}
            values={{ user, actor }}
            components={{ b: <strong className="font-semibold text-foreground" /> }}
          />{' '}
          <time
            dateTime={row.message.created_at}
            title={fmt.full.format(at)}
            className="text-xs whitespace-nowrap tabular-nums"
          >
            {fmt.time.format(at)}
          </time>
        </span>
      </p>
    </div>
  );
}
