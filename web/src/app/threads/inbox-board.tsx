// SPDX-License-Identifier: AGPL-3.0-only
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { useIsMobile } from '@cenacle/ui/hooks/use-mobile';
import { cn } from '@cenacle/ui/lib/utils';
import { ChannelIcon } from '../chat/channel-icon';
import { useActiveWorkspace } from '../chat/active-workspace';
import { UserAvatar } from '../profile/avatar';
import { plainText } from '../search/search';
import { openMessage } from './open-message';
import { activityQuery, type ActivityItem } from './threads';
import { dateLocale } from '../../i18n/time-format';

const keyOf = (a: ActivityItem) => `${a.kind}:${a.message.id}:${a.actor.id}:${a.emoji}`;
const SEEN_LIMIT = 1000;

/**
 * What the person has seen on the board, per workspace, on this device. A
 * row stays lit until it is opened or marked seen.
 */
function useSeen(workspaceId: string) {
  const storageKey = `cenacle.inbox.seen.${workspaceId}`;
  const [seen, setSeen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const mark = (keys: string[]) =>
    setSeen((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      const list = [...next].slice(-SEEN_LIMIT);
      try {
        localStorage.setItem(storageKey, JSON.stringify(list));
      } catch {
        // Storage may be full or blocked; the board still works for this visit.
      }
      return new Set(list);
    });
  return { seen, mark };
}

/** "Today", "Yesterday" or the date, for the group rows of the board. */
function useDayLabel() {
  const { t, i18n } = useTranslation();
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'full' });
  return (d: Date) => {
    const today = new Date();
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    return same(d, today) ? t('inbox.today') : same(d, y) ? t('inbox.yesterday') : date.format(d);
  };
}

/**
 * The Inbox as a departures board: what needs the person, one row each, in
 * fixed columns (time, where, from, what, status, actions). Rows that changed
 * and were not seen stay lit; on phones the rows stack.
 */
export function InboxBoard() {
  const ws = useActiveWorkspace().id;
  // What was seen is kept per workspace, so the board waits for it.
  return ws ? <Board key={ws} ws={ws} /> : <BoardSkeleton />;
}

function Board({ ws }: { ws: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const list = useInfiniteQuery(activityQuery(ws));
  const { seen, mark } = useSeen(ws);
  const day = useDayLabel();
  const time = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (list.isPending) return <BoardSkeleton />;
  if (list.isError) return null;
  const items = list.data.pages.flatMap((p) => p.items);
  const unseen = items.filter((a) => !seen.has(keyOf(a)));
  if (items.length === 0)
    return (
      <p role="status" className="py-10 text-center text-sm text-muted-foreground">
        {t('inbox.empty')}
      </p>
    );

  // Rows grouped by day, newest first.
  const groups: { label: string; rows: ActivityItem[] }[] = [];
  for (const a of items) {
    const label = day(new Date(a.at));
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(a);
    else groups.push({ label, rows: [a] });
  }

  const open = (a: ActivityItem) => {
    mark([keyOf(a)]);
    openMessage(navigate, a.message);
  };
  const what = (a: ActivityItem) =>
    a.kind === 'reaction'
      ? t('inbox.kind.reaction', { emoji: a.emoji })
      : t(`inbox.kind.${a.kind}`);
  const status = (a: ActivityItem, lit: boolean) => (
    <span className="flex flex-wrap items-center gap-1.5">
      {a.kind === 'mention' && (
        <span className="rounded-[4px] bg-mention-bg px-1 text-[12px] font-semibold text-mention">
          {t('inbox.status.you')}
        </span>
      )}
      <span className={cn('text-[13px]', lit ? 'font-semibold' : 'text-muted-foreground')}>
        {lit ? t('inbox.status.new') : t('inbox.status.seen')}
      </span>
    </span>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground" role="status">
          {t('inbox.unseen', { count: unseen.length })}
        </p>
        {unseen.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => mark(unseen.map(keyOf))}>
            {t('inbox.markAllSeen')}
          </Button>
        )}
      </div>

      {mobile ? (
        <div className="flex flex-col">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h2 className="bg-secondary px-4 py-2 text-[12.5px] font-semibold">{g.label}</h2>
              <ul>
                {g.rows.map((a) => {
                  const lit = !seen.has(keyOf(a));
                  return (
                    <li
                      key={keyOf(a)}
                      data-testid="inbox-row"
                      data-lit={lit || undefined}
                      className={cn('border-b px-4 py-3', lit ? 'bg-muted' : 'bg-background')}
                    >
                      <button
                        type="button"
                        className="flex w-full min-w-0 flex-col gap-1 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        onClick={() => open(a)}
                      >
                        <span className="flex items-baseline gap-2 text-[13px]">
                          <time
                            dateTime={a.at}
                            className="font-mono text-[14px] font-medium tabular-nums"
                          >
                            {time.format(new Date(a.at))}
                          </time>
                          <span className="truncate text-muted-foreground">{a.channel.name}</span>
                          <span className="ms-auto">{status(a, lit)}</span>
                        </span>
                        <span className="text-[14px]">
                          <span className="font-semibold">{a.actor.display_name}</span> · {what(a)}
                        </span>
                        <span className="line-clamp-2 text-[14px] text-muted-foreground">
                          {plainText(a.message.body)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-rule-strong">
          <table className="w-full min-w-[56rem] table-fixed border-collapse text-start">
            <colgroup>
              <col className="w-[96px]" />
              <col className="w-[188px]" />
              <col className="w-[168px]" />
              <col />
              <col className="w-[104px]" />
              <col className="w-[176px]" />
            </colgroup>
            <thead className="bg-brand-forest text-brand-bone">
              <tr className="h-10 text-[12.5px]">
                {(['time', 'where', 'from', 'what', 'status', 'actions'] as const).map((c) => (
                  <th key={c} scope="col" className="px-3 font-medium">
                    {t(`inbox.columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.label}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={6}
                    className="border-t bg-secondary px-3 py-1.5 text-[12.5px] font-semibold"
                  >
                    {g.label}
                  </th>
                </tr>
                {g.rows.map((a) => {
                  const lit = !seen.has(keyOf(a));
                  return (
                    <tr
                      key={keyOf(a)}
                      data-testid="inbox-row"
                      data-lit={lit || undefined}
                      className={cn(
                        'h-[62px] border-t align-middle',
                        lit ? 'bg-muted' : 'bg-background',
                      )}
                    >
                      <td className="px-3">
                        <time
                          dateTime={a.at}
                          className="font-mono text-[15px] font-medium whitespace-nowrap tabular-nums"
                        >
                          {time.format(new Date(a.at))}
                        </time>
                      </td>
                      <td className="px-3">
                        <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
                          <ChannelIcon
                            channel={{ kind: a.channel.kind, visibility: 'public' }}
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="truncate">{a.channel.name}</span>
                        </span>
                      </td>
                      <td className="px-3">
                        <span className="flex min-w-0 items-center gap-2 text-[13.5px]">
                          <UserAvatar userId={a.actor.id} name={a.actor.display_name} size="xs" />
                          <span className="truncate">{a.actor.display_name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="block text-[13px] text-muted-foreground">{what(a)}</span>
                        <span className="line-clamp-1 text-[14px]">
                          {plainText(a.message.body)}
                        </span>
                      </td>
                      <td className="px-3">{status(a, lit)}</td>
                      <td className="px-3">
                        <span className="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t('inbox.openNamed', { name: a.actor.display_name })}
                            onClick={() => open(a)}
                          >
                            {t('inbox.open')}
                          </Button>
                          {lit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('inbox.markSeenNamed', { name: a.actor.display_name })}
                              onClick={() => mark([keyOf(a)])}
                            >
                              {t('inbox.markSeen')}
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('home.more')}
        </Button>
      )}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-px overflow-hidden rounded-[10px] border">
      <div className="h-10 bg-brand-forest" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[62px] animate-pulse bg-muted/60" />
      ))}
    </div>
  );
}
