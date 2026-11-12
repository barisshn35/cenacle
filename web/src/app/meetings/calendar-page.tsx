// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronLeftIcon, ChevronRightIcon, PhoneIcon, PlusIcon, RssIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { useIsMobile } from '@cenacle/ui/hooks/use-mobile';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import { channelsQuery } from '../chat/data';
import { dateLocale } from '../../i18n/time-format';
import {
  addDays,
  calendarQuery,
  DAY_MS,
  joinable,
  monthGrid,
  sameDay,
  startOfDay,
  startOfWeek,
  type CalendarItem,
} from './data';
import { joinMeeting } from './join';
import { MeetingDialog } from './meeting-dialog';
import { MeetingDetails } from './meeting-details';
import { SubscribeDialog } from './subscribe-dialog';

/**
 * Four ways to see the same calendar, each person's choice on their device:
 * an agenda (the days as a list), a board (days as rows along the hours), a
 * planner (days as columns of cards) and today beside the month.
 */
type View = 'agenda' | 'board' | 'planner' | 'today';
const VIEWS: View[] = ['agenda', 'board', 'planner', 'today'];
const VIEW_KEY = 'cenacle.calendar.view';
/** How many days the agenda shows. */
const AGENDA_DAYS = 14;

function savedView(): View | null {
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null;
    return v && VIEWS.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/** The next whole or half hour from now (a new meeting's start). */
function nextHalfHour(): Date {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

/** One calendar item as shown: an occurrence with its start and end. */
interface Shown {
  item: CalendarItem;
  start: Date;
  end: Date;
}

/** The time now, again every half minute (what is next, Join, the now line). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const keyOf = (s: Shown) => `${s.item.id}-${s.item.starts_at}`;
const isPast = (s: Shown, now: number) => +s.end <= now;
const onDay = (shown: Shown[], d: Date) =>
  shown.filter((s) => +s.start < +d + DAY_MS && +s.end > +d).sort((a, b) => +a.start - +b.start);

/** The look of an item by its answer (never by colour alone: its words too). */
function itemClass(s: Shown) {
  if (s.item.kind === 'event') return 'border-border bg-muted text-foreground';
  switch (s.item.response) {
    case 'pending':
      return 'border-dashed border-accent-brand/70 bg-background text-foreground';
    case 'maybe':
      return 'border-dotted border-accent-brand/70 bg-background text-foreground';
    case 'no':
      return 'border-border bg-background text-muted-foreground line-through';
    default:
      return 'border-accent-brand/40 bg-accent-brand/12 text-foreground';
  }
}

/** A day's dot in the month: filled when one goes, outlined while unanswered or maybe. */
function dotClass(s: Shown) {
  if (s.item.kind === 'event') return 'border-muted-foreground/50 bg-muted';
  if (s.item.response === 'yes') return 'border-accent-brand bg-accent-brand';
  if (s.item.response === 'pending') return 'border-dashed border-accent-brand';
  if (s.item.response === 'maybe') return 'border-dotted border-accent-brand';
  return 'border-border';
}

function useWords(locale?: string) {
  const { t } = useTranslation();
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const longDay = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  // One's own answer, as one says it ("Going"), or that it waits for one.
  const answer = (s: Shown) =>
    s.item.kind === 'event'
      ? t('meetings.event')
      : s.item.response === 'pending'
        ? t('meetings.answers.pending')
        : t(`meetings.answer.${s.item.response}`);
  return {
    time,
    longDay,
    answer,
    // Starts with what the item shows (its title and time), then the rest.
    label: (s: Shown) =>
      `${s.item.title} ${time.format(s.start)}, ${longDay.format(s.start)}, ${time.format(s.start)}–${time.format(s.end)}, ${answer(s)}`,
  };
}

export function CalendarView() {
  const { t, i18n } = useTranslation();
  const mobile = useIsMobile();
  const ws = useActiveWorkspace();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { meeting?: string };
  const [view, setViewState] = useState<View>(() => savedView() ?? 'agenda');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [planning, setPlanning] = useState<Date | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [opened, setOpened] = useState<{ id: string; start?: Date; end?: Date } | null>(null);
  const locale = dateLocale(i18n.language);
  // On a phone the agenda fits; the others need the width.
  const shownView: View = mobile ? 'agenda' : view;
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Remembered for this visit only.
    }
  };
  // A meeting named in the address (e-mails link to it) opens at once.
  const current = opened ?? (search.meeting ? { id: search.meeting } : null);

  const range = useMemo(() => {
    if (shownView === 'today') return monthGrid(anchor);
    if (shownView === 'agenda') return { from: anchor, to: addDays(anchor, AGENDA_DAYS) };
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }, [shownView, anchor]);
  const items = useQuery(calendarQuery(range.from, range.to));
  const shown: Shown[] = (items.data ?? []).map((item) => ({
    item,
    start: new Date(item.starts_at),
    end: new Date(item.ends_at),
  }));

  const step = (dir: 1 | -1) => {
    if (shownView === 'today')
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else setAnchor(addDays(anchor, dir * 7));
  };
  const title =
    shownView === 'today'
      ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor)
      : new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).formatRange(range.from, addDays(range.to, -1));
  const open = (s: Shown) => {
    if (s.item.kind === 'event') void navigate({ to: '/events' });
    else setOpened({ id: s.item.id, start: s.start, end: s.end });
  };

  return (
    <div className="flex flex-col gap-4 max-sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setAnchor(startOfDay(new Date()))}>
          {t('meetings.today')}
        </Button>
        <div className="flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(`meetings.previous.${shownView}`)}
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(`meetings.next.${shownView}`)}
            onClick={() => step(1)}
          >
            <ChevronRightIcon strokeWidth={1.75} />
          </Button>
        </div>
        <h2 className="min-w-0 text-base font-semibold tabular-nums" aria-live="polite">
          {title}
        </h2>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {!mobile && (
            <div
              role="group"
              aria-label={t('meetings.viewLabel')}
              className="flex rounded-lg border p-0.5"
            >
              {VIEWS.map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={view === v ? 'secondary' : 'ghost'}
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {t(`meetings.views.${v}`)}
                </Button>
              ))}
            </div>
          )}
          <Button variant="outline" onClick={() => setSubscribing(true)}>
            <RssIcon aria-hidden strokeWidth={1.75} />
            {t('meetings.subscribe.open')}
          </Button>
          {ws.workspace?.role !== 'guest' && (
            <Button onClick={() => setPlanning(nextHalfHour())}>
              <PlusIcon aria-hidden strokeWidth={1.75} />
              {t('meetings.new')}
            </Button>
          )}
        </div>
      </div>

      {items.isError ? (
        <ErrorState
          problem={items.error instanceof ApiError ? items.error.problem : { status: 500 }}
          actions={<Button onClick={() => void items.refetch()}>{t('ui:errors.retry')}</Button>}
        />
      ) : shownView === 'agenda' ? (
        <AgendaView
          from={range.from}
          shown={shown}
          locale={locale}
          loading={items.isPending}
          onOpen={open}
          onDay={setAnchor}
        />
      ) : shownView === 'board' ? (
        <BoardView from={range.from} shown={shown} locale={locale} onOpen={open} />
      ) : shownView === 'planner' ? (
        <PlannerView from={range.from} shown={shown} locale={locale} onOpen={open} />
      ) : (
        <TodayMonthView
          anchor={anchor}
          from={range.from}
          shown={shown}
          locale={locale}
          onOpen={open}
        />
      )}

      {planning && ws.id && (
        <MeetingDialog workspaceId={ws.id} start={planning} onClose={() => setPlanning(null)} />
      )}
      {current && (
        <MeetingDetails
          id={current.id}
          occurrence={
            current.start && current.end ? { start: current.start, end: current.end } : undefined
          }
          onClose={() => {
            setOpened(null);
            if (search.meeting) void navigate({ to: '/calendar', search: {} });
          }}
        />
      )}
      {subscribing && <SubscribeDialog onClose={() => setSubscribing(false)} />}
    </div>
  );
}

// --- shared pieces -------------------------------------------------------------

/** Join, when a meeting's call can be joined now. */
function JoinButton({ s, size = 'sm' }: { s: Shown; size?: 'sm' | 'default' | 'lg' }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const self = useSession().user.id;
  if (s.item.kind !== 'meeting' || !s.item.channel_id || !joinable(s.start, s.end)) return null;
  return (
    <Button
      size={size}
      onClick={() => void joinMeeting(queryClient, s.item.channel_id!, s.item.title, self)}
    >
      <PhoneIcon aria-hidden strokeWidth={1.75} />
      {t('meetings.join')}
    </Button>
  );
}

/** "in 12 minutes", "now", "tomorrow"… for the next meeting. */
function useWhen(locale?: string) {
  const { t } = useTranslation();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return (s: Shown) => {
    const ms = +s.start - Date.now();
    if (ms <= 0) return t('meetings.now');
    const min = Math.round(ms / 60_000);
    if (min < 60) return rtf.format(min, 'minute');
    if (min < 24 * 60) return rtf.format(Math.round(min / 60), 'hour');
    return rtf.format(Math.round(min / (24 * 60)), 'day');
  };
}

/** The first meeting still to come (or going on), not declined. */
const nextOf = (shown: Shown[], now: number) =>
  shown
    .filter((s) => s.item.kind === 'meeting' && s.item.response !== 'no' && +s.end > now)
    .sort((a, b) => +a.start - +b.start)[0];

function Tag({ s, children }: { s: Shown; children: ReactNode }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-xs whitespace-nowrap',
        s.item.kind === 'event'
          ? 'border-border bg-muted text-muted-foreground'
          : s.item.response === 'pending'
            ? 'border-dashed border-accent-brand text-accent-brand'
            : s.item.response === 'maybe'
              ? 'border-dotted border-accent-brand text-muted-foreground'
              : 'border-accent-brand/40 bg-accent-brand/10',
      )}
    >
      {children}
    </span>
  );
}

function Legend() {
  const { t } = useTranslation();
  const swatch = (cls: string, label: string) => (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn('h-3 w-5 rounded-sm border', cls)} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      {swatch('border-accent-brand/40 bg-accent-brand/12', t('meetings.answer.yes'))}
      {swatch('border-dashed border-accent-brand/70', t('meetings.answers.pending'))}
      {swatch('border-dotted border-accent-brand/70', t('meetings.answer.maybe'))}
      {swatch('border-border bg-muted', t('meetings.event'))}
    </div>
  );
}

function Empty() {
  const { t } = useTranslation();
  return (
    <p role="status" className="py-6 text-sm text-muted-foreground">
      {t('meetings.empty')}
    </p>
  );
}

/** Overlapping items share space side by side (lane of how many). */
function lanes(day: Shown[], minMs = 0): { s: Shown; lane: number; of: number }[] {
  // An item takes at least minMs of room (a short one is drawn wider).
  const endOf = (s: Shown) => Math.max(+s.end, +s.start + minMs);
  const sorted = [...day].sort((a, b) => +a.start - +b.start || endOf(b) - endOf(a));
  const out: { s: Shown; lane: number; of: number }[] = [];
  let cluster: { s: Shown; lane: number; of: number }[] = [];
  let clusterEnd = 0;
  let ends: number[] = [];
  const close = () => {
    for (const c of cluster) c.of = Math.max(1, ends.length);
    out.push(...cluster);
    cluster = [];
    ends = [];
  };
  for (const s of sorted) {
    if (cluster.length && +s.start >= clusterEnd) close();
    let lane = ends.findIndex((e) => e <= +s.start);
    if (lane < 0) {
      lane = ends.length;
      ends.push(endOf(s));
    } else ends[lane] = endOf(s);
    cluster.push({ s, lane, of: 1 });
    clusterEnd = Math.max(clusterEnd, endOf(s));
  }
  close();
  return out;
}

/** The hours a day view spans: the working day, widened to fit what is in it. */
function hourSpan(shown: Shown[], days: Date[]): [number, number] {
  let first = 8;
  let last = 19;
  for (const d of days)
    for (const s of onDay(shown, d)) {
      first = Math.min(first, Math.max(0, Math.floor((+s.start - +d) / 3600_000)));
      last = Math.max(last, Math.min(24, Math.ceil((+s.end - +d) / 3600_000)));
    }
  return [first, last];
}

// --- A · agenda --------------------------------------------------------------------

function AgendaView({
  from,
  shown,
  locale,
  loading,
  onOpen,
  onDay: pickDay,
}: {
  from: Date;
  shown: Shown[];
  locale?: string;
  loading: boolean;
  onOpen: (s: Shown) => void;
  onDay: (d: Date) => void;
}) {
  const { t } = useTranslation();
  const channels = useQuery(channelsQuery).data ?? [];
  const { time, answer } = useWords(locale);
  const when = useWhen(locale);
  const dayName = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  const dayDate = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' });
  const now = useNow();
  const today = startOfDay(new Date(now));
  const next = nextOf(shown, now);
  const days = Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(from, i))
    .map((d) => ({ d, rows: onDay(shown, d) }))
    .filter((g) => g.rows.length > 0);
  const placeOf = (s: Shown) => channels.find((c) => c.id === s.item.channel_id)?.name;
  const heading = (d: Date) =>
    sameDay(d, today)
      ? t('meetings.today')
      : sameDay(d, addDays(today, 1))
        ? t('meetings.tomorrow')
        : dayName.format(d);

  return (
    <div className="flex flex-col gap-6" data-testid="calendar-agenda">
      {next && (
        <section
          aria-label={t('meetings.nextUp')}
          className="grid grid-cols-[152px_minmax(0,1fr)_auto] items-center gap-5 rounded-[10px] border bg-card px-5 py-4 max-sm:grid-cols-1 max-sm:gap-2"
        >
          <div className="text-end max-sm:text-start">
            <div className="text-[28px] leading-8 font-semibold tracking-[-0.02em] tabular-nums">
              {time.format(next.start)}
            </div>
            <div className="text-[13px] font-semibold text-accent-brand">{when(next)}</div>
          </div>
          <div className="min-w-0 border-s ps-5 max-sm:border-0 max-sm:ps-0">
            <div className="truncate text-[17px] font-semibold">{next.item.title}</div>
            <div className="text-sm text-muted-foreground tabular-nums">
              {dayDate.format(next.start)}, {time.format(next.start)}–{time.format(next.end)}
              {placeOf(next) && `, ${placeOf(next)}`}
            </div>
          </div>
          <div className="flex gap-2">
            <JoinButton s={next} size="lg" />
            {!joinable(next.start, next.end) && (
              <Button variant="outline" onClick={() => onOpen(next)}>
                {t('meetings.open')}
              </Button>
            )}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-start gap-8">
        <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-5">
          {!loading && days.length === 0 && <Empty />}
          {days.map(({ d, rows }) => (
            <section key={d.toDateString()} aria-label={dayDate.format(d)}>
              <h3
                className={cn(
                  'mb-1 grid grid-cols-[152px_minmax(0,1fr)] gap-5 text-[13px] font-semibold max-sm:grid-cols-[72px_minmax(0,1fr)] max-sm:gap-3',
                  sameDay(d, today) && 'text-accent-brand',
                )}
              >
                <span className="text-end">{heading(d)}</span>
                <span className="font-medium text-muted-foreground">{dayDate.format(d)}</span>
              </h3>
              <ul>
                {rows.map((s) => (
                  <li key={keyOf(s)} className={cn('border-t', isPast(s, now) && 'opacity-55')}>
                    <button
                      type="button"
                      data-testid="calendar-item"
                      onClick={() => onOpen(s)}
                      className="grid min-h-12 w-full grid-cols-[152px_minmax(0,1fr)_auto] items-baseline gap-5 py-2.5 text-start text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:grid-cols-[72px_minmax(0,1fr)] max-sm:gap-3"
                    >
                      <span className="text-end text-muted-foreground tabular-nums">
                        <strong className="font-semibold text-foreground">
                          {time.format(s.start)}
                        </strong>{' '}
                        <span className="max-sm:hidden">– {time.format(s.end)}</span>
                      </span>
                      <span className="min-w-0">
                        <span className="font-semibold">{s.item.title}</span>
                        {placeOf(s) && (
                          <span className="text-muted-foreground"> · {placeOf(s)}</span>
                        )}
                      </span>
                      <span className="max-sm:col-start-2">
                        <Tag s={s}>{answer(s)}</Tag>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <MiniMonth
          anchor={from}
          shown={shown}
          locale={locale}
          onDay={pickDay}
          className="flex-[1_1_260px] max-w-[300px] max-lg:hidden"
        />
      </div>
    </div>
  );
}

/** A small month beside the agenda: the shown days lit, busy days bold. */
function MiniMonth({
  anchor,
  shown,
  locale,
  onDay: pickDay,
  className,
}: {
  anchor: Date;
  shown: Shown[];
  locale?: string;
  onDay: (d: Date) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { from } = monthGrid(anchor);
  const head = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  const full = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const today = new Date();
  const shownEnd = addDays(anchor, AGENDA_DAYS);
  return (
    <aside
      aria-label={new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
        anchor,
      )}
      className={cn('rounded-[10px] border bg-card p-4', className)}
    >
      <div className="mb-2 text-sm font-semibold">
        {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor)}
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs tabular-nums">
        {days.slice(0, 7).map((d) => (
          <span key={d.getDay()} aria-hidden className="py-1 text-muted-foreground">
            {head.format(d)}
          </span>
        ))}
        {days.map((d) => {
          const busy = onDay(shown, d).length > 0;
          const inView = +d >= +anchor && +d < +shownEnd;
          return (
            <button
              key={d.toISOString()}
              type="button"
              aria-label={t('meetings.showFrom', { day: full.format(d) })}
              aria-current={sameDay(d, today) ? 'date' : undefined}
              onClick={() => pickDay(d)}
              className={cn(
                'min-h-8 rounded-md outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                d.getMonth() !== anchor.getMonth() && 'text-muted-foreground',
                inView && 'bg-muted',
                busy && 'font-semibold',
                sameDay(d, today) && 'bg-accent-brand text-accent-brand-foreground',
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t('meetings.miniHint')}</p>
    </aside>
  );
}

// --- B · board -----------------------------------------------------------------------

const LANE_PX = 44;
/** On the board a meeting is drawn at least this long, so its title fits. */
const BOARD_MIN_MS = 75 * 60_000;

function BoardView({
  from,
  shown,
  locale,
  onOpen,
}: {
  from: Date;
  shown: Shown[];
  locale?: string;
  onOpen: (s: Shown) => void;
}) {
  const { t } = useTranslation();
  const { time, label } = useWords(locale);
  const dayName = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  const dayDate = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' });
  const hour = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const week = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const [first, last] = hourSpan(shown, week);
  const span = last - first;
  const now = new Date(useNow());
  const pct = (d: Date, at: Date) => (((+at - +d) / 3600_000 - first) / span) * 100;
  // Weekend days without meetings fold into one line.
  const rows = week.filter((d, i) => i < 5 || onDay(shown, d).length > 0);
  const quietWeekend = rows.length < 7;
  return (
    <div className="flex flex-col gap-3" data-testid="calendar-board">
      <div className="overflow-x-auto rounded-[10px] border bg-card">
        <div className="min-w-[860px]">
          <div className="grid grid-cols-[148px_minmax(0,1fr)] border-b bg-muted">
            <span className="px-3.5 py-2.5 text-xs font-semibold text-muted-foreground">
              {t('meetings.day')}
            </span>
            <div
              className="grid"
              style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: span }, (_, h) => (
                <span
                  key={h}
                  className="border-s px-1.5 py-2.5 font-mono text-[11.5px] text-muted-foreground tabular-nums"
                >
                  {hour.format(new Date(2026, 0, 1, first + h))}
                </span>
              ))}
            </div>
          </div>
          {rows.map((d) => {
            const placed = lanes(onDay(shown, d), BOARD_MIN_MS);
            const count = Math.max(1, ...placed.map((p) => p.of));
            const today = sameDay(d, now);
            return (
              <div
                key={d.toDateString()}
                className={cn(
                  'grid grid-cols-[148px_minmax(0,1fr)] border-b last:border-b-0',
                  today && 'bg-accent-brand/5',
                )}
                aria-current={today ? 'date' : undefined}
              >
                <div className="flex flex-col justify-center gap-0.5 px-3.5 py-3">
                  <strong className={cn('font-semibold', today && 'text-accent-brand')}>
                    {dayName.format(d)}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {today ? `${t('meetings.today')}, ` : ''}
                    {dayDate.format(d)}
                  </span>
                </div>
                <div
                  className="relative"
                  style={{
                    height: count * LANE_PX + 20,
                    backgroundImage:
                      'linear-gradient(to right, var(--border) 1px, transparent 1px)',
                    backgroundSize: `calc(100% / ${span}) 100%`,
                  }}
                >
                  {placed.map(({ s, lane }) => {
                    const left = Math.max(0, pct(d, s.start));
                    const right = Math.min(
                      100,
                      pct(d, new Date(Math.max(+s.end, +s.start + BOARD_MIN_MS))),
                    );
                    return (
                      <button
                        key={keyOf(s)}
                        type="button"
                        aria-label={label(s)}
                        data-testid="calendar-item"
                        onClick={() => onOpen(s)}
                        className={cn(
                          'absolute overflow-hidden rounded-md border px-2 py-1 text-start text-xs leading-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                          itemClass(s),
                          isPast(s, +now) && 'opacity-55',
                        )}
                        style={{
                          top: 10 + lane * LANE_PX,
                          height: LANE_PX - 6,
                          left: `calc(${left}% + 2px)`,
                          width: `calc(${Math.max(right - left, 4)}% - 4px)`,
                        }}
                      >
                        <span className="block truncate font-semibold">{s.item.title}</span>{' '}
                        <span className="block truncate text-muted-foreground tabular-nums">
                          {time.format(s.start)}
                        </span>
                      </button>
                    );
                  })}
                  {today && +now >= +d + first * 3600_000 && +now < +d + last * 3600_000 && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 z-10 w-0.5 bg-accent-brand"
                      style={{ left: `${pct(d, now)}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
          {quietWeekend && (
            <div className="grid grid-cols-[148px_minmax(0,1fr)] text-sm text-muted-foreground">
              <span className="px-3.5 py-3">{t('meetings.weekend')}</span>
              <span className="px-1.5 py-3">{t('meetings.nothingPlanned')}</span>
            </div>
          )}
        </div>
      </div>
      <Legend />
    </div>
  );
}

// --- C · planner ------------------------------------------------------------------

function PlannerView({
  from,
  shown,
  locale,
  onOpen,
}: {
  from: Date;
  shown: Shown[];
  locale?: string;
  onOpen: (s: Shown) => void;
}) {
  const { t } = useTranslation();
  const { time, answer, longDay } = useWords(locale);
  const dayName = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  const shortName = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const week = Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => ({
    d,
    rows: onDay(shown, d),
  }));
  const now = new Date(useNow());
  // Today wider; an empty weekend day narrower.
  const tracks = week
    .map(({ d, rows }, i) =>
      sameDay(d, now) ? '1.5fr' : i >= 5 && rows.length === 0 ? '0.6fr' : '1fr',
    )
    .map((f) => `minmax(0, ${f})`)
    .join(' ');
  return (
    <div className="overflow-x-auto" data-testid="calendar-planner">
      <div
        className="grid min-w-[980px] items-start gap-2.5"
        style={{ gridTemplateColumns: tracks }}
      >
        {week.map(({ d, rows }) => {
          const today = sameDay(d, now);
          return (
            <section
              key={d.toDateString()}
              aria-label={longDay.format(d)}
              aria-current={today ? 'date' : undefined}
              className={cn(
                'flex min-h-[540px] flex-col gap-2 rounded-[10px] border p-3',
                today ? 'border-accent-brand bg-accent-brand/5' : rows.length ? 'bg-card' : '',
              )}
            >
              <header className="flex items-baseline gap-2 border-b pb-2">
                <span
                  className={cn(
                    'text-[26px] leading-8 font-semibold tracking-[-0.02em] tabular-nums',
                    today && 'text-accent-brand',
                  )}
                >
                  {d.getDate()}
                </span>
                <span className="truncate text-[13px] text-muted-foreground">
                  {rows.length === 0 && d.getDay() % 6 === 0
                    ? shortName.format(d)
                    : dayName.format(d)}
                </span>
                {today && (
                  <span className="ms-auto rounded-full bg-accent-brand px-2 py-0.5 text-[11px] font-semibold text-accent-brand-foreground">
                    {t('meetings.today')}
                  </span>
                )}
              </header>
              {rows.map((s) => (
                <div
                  key={keyOf(s)}
                  className={cn('flex flex-col gap-1.5', isPast(s, +now) && 'opacity-50')}
                >
                  <button
                    type="button"
                    data-testid="calendar-item"
                    onClick={() => onOpen(s)}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg border p-2.5 text-start text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                      itemClass(s),
                    )}
                  >
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {time.format(s.start)} – {time.format(s.end)}
                    </span>
                    <span className="leading-snug font-semibold">{s.item.title}</span>
                    <span className="text-xs text-muted-foreground">{answer(s)}</span>
                  </button>
                  <JoinButton s={s} />
                </div>
              ))}
              {rows.length === 0 && (
                <p className="text-xs text-muted-foreground">{t('meetings.nothingPlanned')}</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// --- D · today and the month ---------------------------------------------------------

const HOUR_PX = 44;

function TodayMonthView({
  anchor,
  from,
  shown,
  locale,
  onOpen,
}: {
  anchor: Date;
  from: Date;
  shown: Shown[];
  locale?: string;
  onOpen: (s: Shown) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Date | null>(null);
  const now = new Date(useNow());
  const today = startOfDay(now);
  // The day on the left: the one picked, else today in this month, else the 1st.
  const day =
    picked ??
    (anchor.getMonth() === today.getMonth() && anchor.getFullYear() === today.getFullYear()
      ? today
      : new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const head = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const full = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  return (
    <div className="flex flex-wrap items-start gap-6" data-testid="calendar-today">
      <DayColumn day={day} shown={shown} locale={locale} onOpen={onOpen} />
      <div className="min-w-0 flex-[999_1_420px] overflow-hidden rounded-[10px] border bg-card">
        <div className="grid grid-cols-7 border-b bg-muted text-xs text-muted-foreground">
          {days.slice(0, 7).map((d) => (
            <span key={d.getDay()} className="px-2.5 py-2">
              {head.format(d)}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d, i) => {
            const mine = onDay(shown, d);
            const selected = sameDay(d, day);
            return (
              <button
                key={d.toISOString()}
                type="button"
                aria-pressed={selected}
                aria-current={sameDay(d, today) ? 'date' : undefined}
                onClick={() => setPicked(d)}
                className={cn(
                  'flex min-h-[84px] flex-col items-start gap-1.5 p-2 text-start outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                  i % 7 !== 0 && 'border-s',
                  i >= 7 && 'border-t',
                  d.getMonth() !== anchor.getMonth() && 'bg-muted/40 text-muted-foreground',
                  selected && 'bg-accent-brand/8 ring-1 ring-accent-brand ring-inset',
                )}
              >
                <span
                  className={cn(
                    'grid size-6 place-items-center rounded-full text-xs font-semibold tabular-nums',
                    sameDay(d, today) && 'bg-accent-brand text-accent-brand-foreground',
                  )}
                >
                  {d.getDate()}
                </span>
                {mine.length > 0 && (
                  <>
                    {' '}
                    <span aria-hidden className="flex flex-wrap gap-1">
                      {mine.slice(0, 6).map((s) => (
                        <span
                          key={keyOf(s)}
                          className={cn('size-2 rounded-full border', dotClass(s))}
                        />
                      ))}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t('meetings.dayCount', { count: mine.length })}
                    </span>
                  </>
                )}
                <span className="sr-only">, {full.format(d)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** One day's hours, with what is in it, the next meeting and the time now. */
function DayColumn({
  day,
  shown,
  locale,
  onOpen,
}: {
  day: Date;
  shown: Shown[];
  locale?: string;
  onOpen: (s: Shown) => void;
}) {
  const { t } = useTranslation();
  const { time, label } = useWords(locale);
  const when = useWhen(locale);
  const scroller = useRef<HTMLDivElement>(null);
  const now = new Date(useNow());
  const isToday = sameDay(day, now);
  const mine = onDay(shown, day);
  const next = isToday ? nextOf(mine, +now) : undefined;
  const hour = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  // The working day (or the first meeting) in view.
  useLayoutEffect(() => {
    const first = mine[0] ? mine[0].start.getHours() : 8;
    if (scroller.current)
      scroller.current.scrollTop = Math.max(0, Math.min(first, 8) - 0.5) * HOUR_PX;
  }, [day.toDateString()]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section
      aria-label={date.format(day)}
      className="flex min-w-0 flex-[1_1_340px] max-w-[440px] flex-col gap-4 rounded-[10px] border bg-card p-5"
    >
      <div>
        {isToday && (
          <p className="text-[13px] font-semibold text-accent-brand">{t('meetings.today')}</p>
        )}
        <h3 className="text-xl font-semibold tracking-[-0.01em]">{date.format(day)}</h3>
      </div>
      {next && (
        <div className="flex flex-col gap-2 rounded-[10px] bg-sidebar p-4 text-sidebar-foreground">
          <span className="text-xs opacity-80">
            {t('meetings.nextUp')}, {when(next)}
          </span>
          <strong className="text-[17px] leading-snug font-semibold">{next.item.title}</strong>
          <span className="text-[13px] tabular-nums opacity-80">
            {time.format(next.start)} – {time.format(next.end)}
          </span>
          <div className="flex gap-2">
            <JoinButton s={next} />
            <Button size="sm" variant="secondary" onClick={() => onOpen(next)}>
              {t('meetings.open')}
            </Button>
          </div>
        </div>
      )}
      <div ref={scroller} className="relative max-h-[52svh] overflow-y-auto">
        <div className="relative" style={{ height: HOUR_PX * 24 }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              aria-hidden
              className="absolute inset-x-0 border-t border-border/70"
              style={{ top: h * HOUR_PX }}
            >
              <span className="block w-12 pt-0.5 text-[11px] text-muted-foreground tabular-nums">
                {hour.format(new Date(2026, 0, 1, h))}
              </span>
            </div>
          ))}
          {lanes(mine).map(({ s, lane, of }) => {
            const top = Math.max(0, (+s.start - +day) / 3600_000) * HOUR_PX;
            const bottom = Math.min(24, (+s.end - +day) / 3600_000) * HOUR_PX;
            return (
              <button
                key={keyOf(s)}
                type="button"
                aria-label={label(s)}
                data-testid="calendar-item"
                onClick={() => onOpen(s)}
                className={cn(
                  'absolute truncate rounded-md border px-2 py-1 text-start text-xs leading-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  itemClass(s),
                  isPast(s, +now) && 'opacity-55',
                )}
                style={{
                  top: top + 1,
                  height: Math.max(bottom - top - 2, 24),
                  left: `calc(3.25rem + (100% - 3.25rem) * ${lane / of})`,
                  width: `calc((100% - 3.25rem) / ${of} - 3px)`,
                }}
              >
                <span className="font-semibold">{s.item.title}</span>{' '}
                <span className="text-muted-foreground tabular-nums">{time.format(s.start)}</span>
              </button>
            );
          })}
          {isToday && (
            <span
              aria-hidden
              className="absolute right-0 left-12 z-10 h-0.5 bg-accent-brand"
              style={{ top: ((+now - +day) / 3600_000) * HOUR_PX }}
            />
          )}
        </div>
      </div>
      {mine.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('meetings.nothingPlanned')}</p>
      )}
    </section>
  );
}
