// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlarmClockIcon, CalendarIcon, TableIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { useIsMobile } from '@cenacle/ui/hooks/use-mobile';
import { cn } from '@cenacle/ui/lib/utils';
import { useActiveWorkspace } from '../chat/active-workspace';
import { ChannelIcon } from '../chat/channel-icon';
import { channelsQuery } from '../chat/data';
import { myTasksQuery } from '../automation/automation';
import { TaskCard } from '../automation/cards';
import { Board, BoardGroup, BoardSection } from '../shell/board';
import { boardCell, boardRow } from '../shell/board-styles';
import { assignedQuery, type AssignedItem } from './collab';
import { dateLocale } from '../../i18n/time-format';

/** What waits for the person: approvals and forms of workflows, then list rows assigned to them. */
export function MyTasks() {
  const { t, i18n } = useTranslation();
  const ws = useActiveWorkspace().id;
  const mobile = useIsMobile();
  const channels = useQuery(channelsQuery).data;
  const tasks = useQuery(myTasksQuery(ws));
  const assigned = useQuery(assignedQuery(ws));
  if (tasks.isPending || assigned.isPending) {
    return (
      <>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </>
    );
  }
  const waiting = tasks.data ?? [];
  const rows = assigned.data ?? [];
  if (waiting.length === 0 && rows.length === 0) {
    return (
      <p role="status" className="py-8 text-center text-sm text-muted-foreground">
        {t('collab.tasks.none')}
      </p>
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    day: 'numeric',
    month: 'short',
  });
  const lists = new Set(rows.map((r) => r.list_title)).size;

  const title = (row: AssignedItem) => (
    <Link
      to="/c/$channelId"
      params={{ channelId: row.channel_id }}
      search={{ tab: row.tab_id }}
      data-testid="assigned-item"
      className="rounded-sm text-[14px] font-semibold break-words outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {row.item.title}
    </Link>
  );
  const list = (row: AssignedItem) => (
    <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
      <TableIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <span className="truncate">{row.list_title}</span>
    </span>
  );
  const channel = (row: AssignedItem) => {
    const known = channels?.find((c) => c.id === row.channel_id);
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
        <ChannelIcon
          channel={{ kind: known?.kind ?? 'standard', visibility: known?.visibility ?? 'public' }}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="truncate">{known?.name ?? row.channel_name}</span>
      </span>
    );
  };
  const due = (row: AssignedItem) => {
    if (!row.due)
      return <span className="text-[13.5px] text-muted-foreground">{t('collab.tasks.noDue')}</span>;
    const late = row.due < today;
    const d = date.format(new Date(`${row.due}T00:00`));
    return (
      <span className={cn('flex items-center gap-1.5 text-[13.5px]', late && 'font-semibold')}>
        {late ? (
          <AlarmClockIcon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
        ) : (
          <CalendarIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
        )}
        {late ? t('collab.tasks.overdue', { date: d }) : t('collab.tasks.due', { date: d })}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {waiting.length > 0 && (
        <BoardSection title={t('collab.tasks.waiting')} count={waiting.length}>
          <ul className="flex flex-col gap-2.5 max-sm:px-4">
            {waiting.map((task) => (
              <li key={task.id}>
                <TaskCard task={task} className="mt-0 max-w-none" />
              </li>
            ))}
          </ul>
        </BoardSection>
      )}
      {rows.length > 0 && (
        <BoardSection
          title={t('collab.tasks.assigned')}
          count={t('collab.tasks.rowsInLists', {
            count: rows.length,
            lists: t('collab.tasks.lists', { count: lists }),
          })}
        >
          {mobile ? (
            <ul className="flex flex-col border-t">
              {rows.map((row) => (
                <li
                  key={row.item.id}
                  className={cn(
                    'flex flex-col gap-1.5 border-b px-4 py-3',
                    row.due && row.due < today && 'bg-muted',
                  )}
                >
                  {title(row)}
                  <span className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    {list(row)}
                    {channel(row)}
                  </span>
                  {due(row)}
                </li>
              ))}
            </ul>
          ) : (
            <>
              <Board
                label={t('collab.tasks.assigned')}
                minWidth="min-w-[48rem]"
                columns={[
                  { label: t('collab.tasks.columns.title') },
                  { label: t('collab.tasks.columns.list'), width: 'w-[200px]' },
                  { label: t('collab.tasks.columns.channel'), width: 'w-[180px]' },
                  { label: t('collab.tasks.columns.due'), width: 'w-[210px]' },
                ]}
              >
                <BoardGroup span={4}>
                  {rows.map((row) => (
                    <tr key={row.item.id} className={boardRow(!!row.due && row.due < today)}>
                      <td className={boardCell}>{title(row)}</td>
                      <td className={boardCell}>{list(row)}</td>
                      <td className={boardCell}>{channel(row)}</td>
                      <td className={boardCell}>{due(row)}</td>
                    </tr>
                  ))}
                </BoardGroup>
              </Board>
              <p className="text-[13px] text-muted-foreground">{t('collab.tasks.hint')}</p>
            </>
          )}
        </BoardSection>
      )}
    </div>
  );
}
