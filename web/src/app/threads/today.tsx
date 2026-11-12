// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlarmClockIcon, CalendarIcon, ClipboardCheckIcon, TableIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { cn } from '@cenacle/ui/lib/utils';
import { SummarizeButton } from '../ai/ai-ui';
import { myTasksQuery } from '../automation/automation';
import { useActiveWorkspace } from '../chat/active-workspace';
import { ChannelIcon } from '../chat/channel-icon';
import { channelsQuery, isConversation, type Channel } from '../chat/data';
import { assignedQuery } from '../collab/collab';
import { eventsQuery } from '../community/community';
import { dateLocale } from '../../i18n/time-format';
import { savedQuery } from './threads';

/** How many rows a part shows before "See all". */
const SHOWN = 6;

/** "2026-11-12" of a moment, in the reader's time zone. */
const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Today: what needs the reader, gathered from the views they would otherwise
 * visit one by one. Mentions and direct messages lead; the day's events, what
 * waits for their answer and the reminders due follow.
 */
export function TodayView() {
  const { t } = useTranslation();
  const ws = useActiveWorkspace().id;
  const channels = useQuery(channelsQuery);
  const events = useQuery(eventsQuery(ws));
  const tasks = useQuery(myTasksQuery(ws));
  const assigned = useQuery(assignedQuery(ws));
  const saved = useQuery(savedQuery);
  const now = new Date();
  const today = dayOf(now);

  // Mentions first, then direct messages, then the most unread.
  const needs = (channels.data ?? [])
    .filter(
      (c) =>
        c.workspace_id === ws &&
        !c.archived &&
        (c.mention_count > 0 || (isConversation(c) && c.unread_count > 0)),
    )
    .sort(
      (a, b) =>
        b.mention_count - a.mention_count ||
        Number(isConversation(b)) - Number(isConversation(a)) ||
        b.unread_count - a.unread_count,
    );
  const todays = (events.data ?? [])
    .filter(
      (e) =>
        !e.canceled &&
        e.me !== 'declined' &&
        dayOf(new Date(e.starts_at)) <= today &&
        new Date(e.ends_at) > now,
    )
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const waiting = tasks.data ?? [];
  const due = (assigned.data ?? []).filter((r) => r.due && r.due <= today);
  const reminders = (saved.data ?? [])
    .filter((s) => s.remind_at && !s.done_at && dayOf(new Date(s.remind_at)) <= today)
    .sort((a, b) => a.remind_at!.localeCompare(b.remind_at!));

  const loading = channels.isPending;
  const nothing =
    !loading &&
    needs.length === 0 &&
    todays.length === 0 &&
    waiting.length === 0 &&
    due.length === 0 &&
    reminders.length === 0;

  return (
    <div className="flex max-w-[1000px] flex-col gap-8" data-testid="today">
      {loading ? (
        <Skeleton className="h-32" />
      ) : nothing ? (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">
          {t('today.clear')}
        </p>
      ) : (
        <>
          {needs.length > 0 && (
            <Part
              title={t('today.needs')}
              count={needs.length}
              all={
                needs.length > SHOWN ? { to: '/unreads', label: t('today.allUnreads') } : undefined
              }
            >
              <ul className="divide-y rounded-[10px] border" data-testid="today-needs">
                {needs.slice(0, SHOWN).map((c) => (
                  <NeedRow key={c.id} channel={c} />
                ))}
              </ul>
            </Part>
          )}
          <div className="grid gap-8 lg:grid-cols-2">
            {todays.length > 0 && (
              <Part title={t('today.events')} count={todays.length}>
                <ul className="grid gap-2" data-testid="today-events">
                  {todays.slice(0, SHOWN).map((e) => (
                    <Line
                      key={e.id}
                      icon={<CalendarIcon aria-hidden className="size-4" strokeWidth={1.75} />}
                      to="/events"
                      title={e.title}
                      detail={<When start={e.starts_at} end={e.ends_at} />}
                      tag={e.me ? t(`community.events.rsvp.${e.me}`) : t('today.noAnswer')}
                    />
                  ))}
                </ul>
              </Part>
            )}
            {(waiting.length > 0 || due.length > 0) && (
              <Part title={t('today.waiting')} count={waiting.length + due.length}>
                <ul className="grid gap-2" data-testid="today-waiting">
                  {waiting.slice(0, SHOWN).map((task) => (
                    <Line
                      key={task.id}
                      icon={
                        <ClipboardCheckIcon aria-hidden className="size-4" strokeWidth={1.75} />
                      }
                      to="/tasks"
                      title={task.title}
                      detail={t(`today.task.${task.kind}`)}
                    />
                  ))}
                  {due.slice(0, Math.max(0, SHOWN - waiting.length)).map((r) => (
                    <Line
                      key={r.item.id}
                      icon={<TableIcon aria-hidden className="size-4" strokeWidth={1.75} />}
                      to="/tasks"
                      title={r.item.title}
                      detail={r.list_title}
                      tag={r.due! < today ? t('today.overdue') : t('today.dueToday')}
                      lit={r.due! < today}
                    />
                  ))}
                </ul>
              </Part>
            )}
            {reminders.length > 0 && (
              <Part title={t('today.reminders')} count={reminders.length}>
                <ul className="grid gap-2" data-testid="today-reminders">
                  {reminders.slice(0, SHOWN).map((s) => (
                    <Line
                      key={s.message.id}
                      icon={<AlarmClockIcon aria-hidden className="size-4" strokeWidth={1.75} />}
                      to="/saved"
                      title={s.message.body.slice(0, 140) || t('today.attachment')}
                      detail={s.channel.name}
                    />
                  ))}
                </ul>
              </Part>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Part({
  title,
  count,
  all,
  children,
}: {
  title: string;
  count: number;
  all?: { to: '/unreads'; label: string };
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className="flex min-h-8 items-center gap-2.5">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <span className="text-[13px] text-muted-foreground tabular-nums">{count}</span>
        {all && (
          <Link
            to={all.to}
            className="hit-target ms-auto rounded-sm text-sm text-accent-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {all.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** A channel or conversation that needs the reader, with its counts and a summary. */
function NeedRow({ channel: c }: { channel: Channel }) {
  const { t } = useTranslation();
  return (
    <li className="flex min-h-[52px] items-center gap-3 px-3 py-1.5">
      <ChannelIcon channel={c} className="size-4 shrink-0 text-muted-foreground" />
      <Link
        to="/c/$channelId"
        params={{ channelId: c.id }}
        className="hit-target min-w-0 flex-1 truncate rounded-sm text-[15px] font-semibold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {c.name}
      </Link>
      {c.mention_count > 0 && (
        <span className="rounded-full bg-mention px-2 py-0.5 text-xs font-semibold text-mention-foreground tabular-nums">
          {t('today.mentions', { count: c.mention_count })}
        </span>
      )}
      {c.unread_count > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('today.unread', { count: c.unread_count })}
        </span>
      )}
      <SummarizeButton channelId={c.id} />
    </li>
  );
}

function Line({
  icon,
  to,
  title,
  detail,
  tag,
  lit = false,
}: {
  icon: ReactNode;
  to: '/events' | '/tasks' | '/saved';
  title: string;
  detail?: ReactNode;
  tag?: string;
  lit?: boolean;
}) {
  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-[10px] border px-3 py-2',
        lit ? 'bg-muted' : 'bg-background',
      )}
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <Link
          to={to}
          className="hit-target truncate rounded-sm text-sm font-semibold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {title}
        </Link>
        {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {tag && <span className="shrink-0 text-xs font-medium">{tag}</span>}
    </li>
  );
}

/** "14:00 – 15:00", or the start's day too when it is not today. */
function When({ start, end }: { start: string; end: string }) {
  const { i18n } = useTranslation();
  const locale = dateLocale(i18n.language);
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const s = new Date(start);
  const e = new Date(end);
  const sameDay = dayOf(s) === dayOf(new Date());
  return (
    <>
      {sameDay ? clock.format(s) : `${day.format(s)} ${clock.format(s)}`} – {clock.format(e)}
    </>
  );
}
