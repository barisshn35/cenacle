// SPDX-License-Identifier: AGPL-3.0-only
import { usePageTitle } from '../shell/use-page-title';
import { AskPage } from '../ai/ai-ui';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  AlarmClockIcon,
  BellOffIcon,
  BellRingIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { cn } from '@cenacle/ui/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { SidebarTrigger } from '@cenacle/ui/components/sidebar';
import { useIsMobile } from '@cenacle/ui/hooks/use-mobile';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { useLayout } from '../../stores/layout';
import { useActiveWorkspace } from '../chat/active-workspace';
import { ChannelIcon } from '../chat/channel-icon';
import { channelsQuery, markRead, setReadLocally, type Channel, type Message } from '../chat/data';
import { MessageBody } from '../chat/markdown/message-body';
import { SPEAKER_GRID } from '../chat/message-list';
import { useSession } from '../auth/session';
import { Board, BoardGroup, BoardTabs } from '../shell/board';
import { boardCell, boardRow } from '../shell/board-styles';
import { openMessage } from './open-message';
import { InboxBoard } from './inbox-board';
import { EventsList } from '../community/events';
import { PlaybooksList } from '../community/playbooks';
import { MyTasks } from '../collab/my-tasks';
import { UserAvatar } from '../profile/avatar';
import { plainText } from '../search/search';
import {
  applySaved,
  followedThreadsQuery,
  markThreadRead,
  savedQuery,
  saveMessage,
  setFollowing,
  threadsChanged,
  unreadsQuery,
  unsaveMessage,
  type SavedItem,
} from './threads';
import { dateLocale } from '../../i18n/time-format';

// Pages few people open load when opened.
const WorkflowsPage = lazy(() =>
  import('../automation/workflows-page').then((m) => ({ default: m.WorkflowsPage })),
);
const CompliancePage = lazy(() =>
  import('../compliance/compliance-page').then((m) => ({ default: m.CompliancePage })),
);
const FederationPage = lazy(() =>
  import('../federation/federation-page').then((m) => ({ default: m.FederationPage })),
);

export type HomeView =
  | 'threads'
  | 'activity'
  | 'saved'
  | 'unreads'
  | 'tasks'
  | 'events'
  | 'playbooks'
  | 'workflows'
  | 'compliance'
  | 'ask'
  | 'federation';

/** Channels are named without "#": their kind is shown by an icon (v0.29). */
function channelLabel(c: { name: string; kind: string }) {
  return c.name;
}

function Shell({
  title,
  subtitle,
  actions,
  mobile,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  mobile: boolean;
  children: ReactNode;
}) {
  usePageTitle(title);
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex h-full min-w-0 flex-col bg-background outline-none"
      aria-labelledby="view-title"
    >
      {mobile && (
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-8 pt-6 pb-10 max-sm:px-0 max-sm:pt-4">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 max-sm:px-4">
            <div className="min-w-0">
              <h1 id="view-title" className="text-2xl leading-8 font-semibold tracking-[-0.015em]">
                {title}
              </h1>
              {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="ms-auto flex gap-2">{actions}</div>}
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}

function Loading() {
  return (
    <>
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </>
  );
}

function Problem({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <ErrorState
      problem={error instanceof ApiError ? error.problem : { status: 500 }}
      actions={<Button onClick={retry}>{t('ui:errors.retry')}</Button>}
    />
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function HomeViewPage({ view, mobile = false }: { view: HomeView; mobile?: boolean }) {
  const { t } = useTranslation();
  return (
    <Shell
      title={t(`home.${view}`)}
      subtitle={t(`home.subtitles.${view}`, { defaultValue: '' }) || undefined}
      actions={view === 'threads' ? <MarkThreadsRead /> : undefined}
      mobile={mobile}
    >
      {view === 'threads' && <ThreadsList />}
      {view === 'activity' && <InboxBoard />}
      {view === 'saved' && <SavedList />}
      {view === 'unreads' && <UnreadsList />}
      {view === 'tasks' && <MyTasks />}
      {view === 'events' && <EventsList />}
      {view === 'playbooks' && <PlaybooksList />}
      <Suspense fallback={<Loading />}>
        {view === 'workflows' && <WorkflowsPage />}
        {view === 'compliance' && <CompliancePage />}
        {view === 'ask' && <AskPage />}
        {view === 'federation' && <FederationPage />}
      </Suspense>
    </Shell>
  );
}

/** A channel as the reader knows it: its own name for conversations, and its visibility. */
function useChannelInfo() {
  const channels = useQuery(channelsQuery).data;
  return (c: { id: string; name: string; kind: string }) => {
    const known = channels?.find((x) => x.id === c.id);
    return {
      name: channelLabel({ ...c, name: known?.name ?? c.name }),
      icon: {
        kind: (known?.kind ?? c.kind) as Channel['kind'],
        visibility: known?.visibility ?? 'public',
      },
    };
  };
}

/** Marks every followed thread with new replies as read. */
function MarkThreadsRead() {
  const { t } = useTranslation();
  const ws = useActiveWorkspace().id;
  const queryClient = useQueryClient();
  const list = useInfiniteQuery(followedThreadsQuery(ws));
  const unread = (list.data?.pages ?? [])
    .flatMap((p) => p.threads)
    .filter((th) => th.unread_count > 0);
  const read = useMutation({
    mutationFn: () => Promise.all(unread.map((th) => markThreadRead(th.root.id, th.last_reply_id))),
    onSettled: () => threadsChanged(queryClient),
    onError: () => toast.error(t('home.readFailed')),
  });
  if (unread.length === 0) return null;
  return (
    <Button variant="outline" disabled={read.isPending} onClick={() => read.mutate()}>
      <CheckIcon strokeWidth={1.75} />
      {t('threads.markAllRead')}
    </Button>
  );
}

function ThreadsList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ws = useActiveWorkspace().id;
  const self = useSession().user.id;
  const info = useChannelInfo();
  const list = useInfiniteQuery(followedThreadsQuery(ws));
  const clock = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    hour: '2-digit',
    minute: '2-digit',
  });
  const day = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  const when = (iso: string) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? clock.format(d) : day.format(d);
  };
  const unfollow = useMutation({
    mutationFn: (rootId: string) => setFollowing(rootId, false),
    onSettled: () => threadsChanged(queryClient),
    onError: () => toast.error(t('threads.followFailed')),
  });
  if (list.isPending) return <Loading />;
  if (list.isError) return <Problem error={list.error} retry={() => void list.refetch()} />;
  const threads = list.data.pages.flatMap((p) => p.threads);
  if (threads.length === 0) return <Empty>{t('home.noThreads')}</Empty>;
  const open = (th: (typeof threads)[number]) => {
    void navigate({ to: '/c/$channelId', params: { channelId: th.channel.id } });
    useLayout.getState().openThread({ channelId: th.channel.id, rootId: th.root.id });
  };
  return (
    <>
      <ul className="flex max-w-[1000px] flex-col gap-3.5">
        {threads.map((th) => {
          const ch = info(th.channel);
          const root = th.root;
          const summary = root.thread;
          return (
            <li
              key={root.id}
              data-testid="followed-thread"
              data-unread={th.unread_count > 0 || undefined}
              className="overflow-hidden rounded-[10px] border border-rule-strong bg-background max-sm:rounded-none max-sm:border-x-0"
            >
              <header className="flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-1 border-b bg-secondary py-2 pe-2.5 ps-4">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                  <ChannelIcon
                    channel={ch.icon}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate">{ch.name}</span>
                </span>
                {summary && (
                  <span className="text-[12.5px] text-muted-foreground">
                    {t('threads.lastReplyLabel')}{' '}
                    <time dateTime={summary.last_reply_at} className="font-mono">
                      {when(summary.last_reply_at)}
                    </time>
                  </span>
                )}
                <span className="ms-auto flex items-center gap-2">
                  {th.mention_count > 0 && (
                    <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-mention px-1 text-[11px] font-semibold text-mention-foreground">
                      {th.mention_count}
                    </span>
                  )}
                  <span
                    className={cn(
                      'text-[13px]',
                      th.unread_count > 0 ? 'font-semibold' : 'text-muted-foreground',
                    )}
                  >
                    {th.mention_count > 0
                      ? t('threads.mentionsAndReplies', {
                          mentions: t('mentions.unread', { count: th.mention_count }),
                          count: th.unread_count,
                        })
                      : th.unread_count > 0
                        ? t('threads.newReplies', { count: th.unread_count })
                        : t('threads.noNewReplies')}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t('threads.openIn', { channel: ch.name })}
                    onClick={() => open(th)}
                  >
                    {t('threads.open')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={unfollow.isPending}
                    onClick={() => unfollow.mutate(root.id)}
                  >
                    <BellOffIcon strokeWidth={1.75} />
                    {t('threads.stopFollowing')}
                  </Button>
                </span>
              </header>
              <div className="py-2.5 pe-4 ps-2 max-sm:px-0">
                <div className={cn(SPEAKER_GRID(), 'py-1')}>
                  <div className="flex min-w-0 items-start justify-end gap-2 text-end max-sm:justify-start max-sm:text-start">
                    <div className="flex min-w-0 flex-col items-end max-sm:order-2 max-sm:flex-row max-sm:items-baseline max-sm:gap-2">
                      <span className="max-w-full truncate text-[13px] leading-[18px] font-semibold">
                        {root.author.display_name}
                      </span>
                      <time
                        dateTime={root.created_at}
                        className="font-mono text-xs leading-4 text-muted-foreground"
                      >
                        {when(root.created_at)}
                      </time>
                    </div>
                    <UserAvatar userId={root.author.id} name={root.author.display_name} size="xs" />
                  </div>
                  <div className="min-w-0 text-[15px] leading-[22px] break-words">
                    <MessageBody body={root.body} mentions={root.mentions ?? []} selfId={self} />
                  </div>
                </div>
                {summary && (
                  <div className={cn(SPEAKER_GRID(), 'min-h-8 items-center')}>
                    <span aria-hidden className="max-sm:hidden" />
                    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <span className="flex gap-0.5">
                        {summary.participants.map((a) => (
                          <UserAvatar key={a.id} userId={a.id} name={a.display_name} size="xs" />
                        ))}
                      </span>
                      <b className="font-semibold text-foreground">
                        {t('threads.replies', { count: summary.reply_count })}
                      </b>
                    </span>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
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
    </>
  );
}

const REMINDERS = ['20m', '1h', '3h', 'tomorrow', 'week'] as const;

function remindAt(choice: (typeof REMINDERS)[number], now = new Date()): string {
  const at = new Date(now);
  switch (choice) {
    case '20m':
      return new Date(now.getTime() + 20 * 60_000).toISOString();
    case '1h':
      return new Date(now.getTime() + 60 * 60_000).toISOString();
    case '3h':
      return new Date(now.getTime() + 3 * 60 * 60_000).toISOString();
    case 'tomorrow':
      at.setDate(at.getDate() + 1);
      at.setHours(9, 0, 0, 0);
      return at.toISOString();
    case 'week':
      at.setDate(at.getDate() + 7);
      at.setHours(9, 0, 0, 0);
      return at.toISOString();
  }
}

type SavedGroup = 'overdue' | 'today' | 'later' | 'none';

function savedGroup(s: SavedItem, now = new Date()): SavedGroup {
  if (!s.remind_at) return 'none';
  const at = new Date(s.remind_at);
  if (at < now) return 'overdue';
  return at.toDateString() === now.toDateString() ? 'today' : 'later';
}

/** Saved messages as a board: reminder, where, from, message and actions. */
function SavedList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mobile = useIsMobile();
  const info = useChannelInfo();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const saved = useQuery(savedQuery);
  const clock = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    hour: '2-digit',
    minute: '2-digit',
  });
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const change = useMutation({
    mutationFn: ({
      item,
      state,
    }: {
      item: SavedItem;
      state: { remind_at?: string | null; done?: boolean } | null;
    }) =>
      state ? saveMessage(item.message.id, state) : unsaveMessage(item.message.id).then(() => null),
    onSuccess: (result, { item }) => applySaved(queryClient, item.message.id, result),
    onError: () => toast.error(t('saved.failed')),
  });
  if (saved.isPending) return <Loading />;
  if (saved.isError) return <Problem error={saved.error} retry={() => void saved.refetch()} />;
  const open = saved.data.filter((s) => !s.done_at);
  const done = saved.data.filter((s) => !!s.done_at);
  const items = tab === 'done' ? done : open;
  const groups: { key: SavedGroup | 'done'; rows: SavedItem[] }[] =
    tab === 'done'
      ? [{ key: 'done', rows: done }]
      : (['overdue', 'today', 'later', 'none'] as const)
          .map((key) => ({
            key,
            rows: open
              .filter((s) => savedGroup(s) === key)
              .sort((a, b) => (a.remind_at ?? '').localeCompare(b.remind_at ?? '')),
          }))
          .filter((g) => g.rows.length > 0);

  const reminder = (s: SavedItem) => {
    if (!s.remind_at || s.done_at) return <span className="text-muted-foreground">—</span>;
    const at = new Date(s.remind_at);
    const group = savedGroup(s);
    return (
      <span className="flex flex-col">
        <span className="flex items-center gap-1.5 font-mono text-[14px] font-medium">
          {group === 'overdue' && (
            <AlarmClockIcon aria-hidden className="size-4" strokeWidth={1.75} />
          )}
          <time dateTime={s.remind_at}>{clock.format(at)}</time>
        </span>
        <span className="text-xs text-muted-foreground">
          {group === 'overdue'
            ? t('saved.overdueSince', {
                date:
                  at.toDateString() === new Date().toDateString()
                    ? t('saved.today')
                    : date.format(at),
              })
            : group === 'today'
              ? t('saved.groups.today')
              : date.format(at)}
        </span>
      </span>
    );
  };
  const where = (s: SavedItem) => {
    const ch = info(s.channel);
    return (
      <span className="flex min-w-0 items-start gap-1.5">
        <ChannelIcon channel={ch.icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold">{ch.name}</span>
          {s.message.root_id && (
            <span className="block text-xs text-muted-foreground">{t('saved.inThread')}</span>
          )}
        </span>
      </span>
    );
  };
  const actions = (s: SavedItem) => (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      {!s.done_at && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                aria-label={t('saved.remindNamed', { name: s.message.author.display_name })}
              />
            }
          >
            <BellRingIcon strokeWidth={1.75} />
            {t('saved.remind')}
            <ChevronDownIcon strokeWidth={1.75} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {REMINDERS.map((r) => {
              const at = remindAt(r);
              return (
                <DropdownMenuItem
                  key={r}
                  onClick={() => change.mutate({ item: s, state: { remind_at: at } })}
                >
                  <ClockIcon strokeWidth={1.75} />
                  {t(`saved.reminders.${r}`)}
                  <span className="ms-auto font-mono text-xs text-muted-foreground">
                    {r === 'tomorrow' || r === 'week'
                      ? date.format(new Date(at))
                      : clock.format(new Date(at))}
                  </span>
                </DropdownMenuItem>
              );
            })}
            {s.remind_at && (
              <DropdownMenuItem
                onClick={() => change.mutate({ item: s, state: { remind_at: null } })}
              >
                <BellOffIcon strokeWidth={1.75} />
                {t('saved.noReminder')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        size="sm"
        variant="outline"
        aria-label={t(s.done_at ? 'saved.undoDoneNamed' : 'saved.markDoneNamed', {
          name: s.message.author.display_name,
        })}
        onClick={() =>
          change.mutate({ item: s, state: s.done_at ? { remind_at: null } : { done: true } })
        }
      >
        {s.done_at ? <RotateCcwIcon strokeWidth={1.75} /> : <CheckIcon strokeWidth={1.75} />}
        {s.done_at ? t('saved.undoDone') : t('saved.markDone')}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('saved.removeNamed', { name: s.message.author.display_name })}
        onClick={() => change.mutate({ item: s, state: null })}
      >
        <Trash2Icon strokeWidth={1.75} />
      </Button>
    </span>
  );
  const message = (s: SavedItem) => (
    <button
      type="button"
      className="line-clamp-2 w-full rounded-sm text-start text-[14px] break-words outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={() => openMessage(navigate, s.message)}
    >
      {plainText(s.message.body)}
    </button>
  );

  return (
    <>
      <div className="max-sm:px-4">
        <BoardTabs
          label={t('home.saved')}
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'open', label: t('saved.tabs.open'), count: open.length },
            { key: 'done', label: t('saved.tabs.done'), count: done.length },
          ]}
          note={mobile ? undefined : t('saved.remindersNote')}
        />
      </div>
      <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {items.length === 0 ? (
          <Empty>{tab === 'open' ? t('saved.none') : t('saved.noneDone')}</Empty>
        ) : mobile ? (
          <div className="flex flex-col">
            {groups.map((g) => (
              <section key={g.key} aria-label={t(`saved.groups.${g.key}`)}>
                {tab === 'open' && (
                  <h2 className="bg-secondary px-4 py-2 text-[12.5px] font-semibold">
                    {t(`saved.groups.${g.key}`)}
                  </h2>
                )}
                <ul>
                  {g.rows.map((s) => (
                    <li
                      key={s.message.id}
                      data-testid="saved-item"
                      className={cn(
                        'flex flex-col gap-2 border-b px-4 py-3',
                        savedGroup(s) === 'overdue' && !s.done_at && 'bg-muted',
                      )}
                    >
                      <div className="flex items-start gap-3 text-[13px]">
                        {where(s)}
                        <span className="ms-auto shrink-0 text-end">{reminder(s)}</span>
                      </div>
                      <span className="flex items-center gap-2 text-[13.5px]">
                        <UserAvatar
                          userId={s.message.author.id}
                          name={s.message.author.display_name}
                          size="xs"
                        />
                        {s.message.author.display_name}
                      </span>
                      {message(s)}
                      {actions(s)}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <Board
            label={t('home.saved')}
            columns={[
              { label: t('saved.columns.reminder'), width: 'w-[124px]' },
              { label: t('saved.columns.where'), width: 'w-[170px]' },
              { label: t('saved.columns.from'), width: 'w-[150px]' },
              { label: t('saved.columns.message') },
              { label: t('saved.columns.actions'), width: 'w-[312px]', align: 'end' },
            ]}
          >
            {groups.map((g) => (
              <BoardGroup
                key={g.key}
                span={5}
                label={tab === 'open' ? t(`saved.groups.${g.key}`) : undefined}
                count={tab === 'open' ? g.rows.length : undefined}
              >
                {g.rows.map((s) => (
                  <tr
                    key={s.message.id}
                    data-testid="saved-item"
                    className={boardRow(savedGroup(s) === 'overdue' && !s.done_at)}
                  >
                    <td className={boardCell}>{reminder(s)}</td>
                    <td className={boardCell}>{where(s)}</td>
                    <td className={boardCell}>
                      <span className="flex min-w-0 items-center gap-2 text-[13.5px]">
                        <UserAvatar
                          userId={s.message.author.id}
                          name={s.message.author.display_name}
                          size="xs"
                        />
                        <span className="truncate">{s.message.author.display_name}</span>
                      </span>
                    </td>
                    <td className={boardCell}>{message(s)}</td>
                    <td className={boardCell}>{actions(s)}</td>
                  </tr>
                ))}
              </BoardGroup>
            ))}
          </Board>
        )}
      </div>
    </>
  );
}

function UnreadsList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ws = useActiveWorkspace().id;
  const channels = useQuery(channelsQuery).data ?? [];
  const unreads = useQuery(unreadsQuery(ws));
  const time = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    hour: '2-digit',
    minute: '2-digit',
  });
  const read = useMutation({
    mutationFn: ({ channelId, messageId }: { channelId: string; messageId: string }) =>
      markRead(channelId, messageId),
    onMutate: ({ channelId, messageId }) => {
      setReadLocally(queryClient, channelId, messageId);
      queryClient.setQueryData<{ channel_id: string; messages: Message[] }[]>(
        unreadsQuery(ws).queryKey,
        (list) => list?.filter((c) => c.channel_id !== channelId),
      );
    },
    onError: () => toast.error(t('home.readFailed')),
  });
  if (unreads.isPending) return <Loading />;
  if (unreads.isError)
    return <Problem error={unreads.error} retry={() => void unreads.refetch()} />;
  if (unreads.data.length === 0) return <Empty>{t('home.noUnreads')}</Empty>;
  return (
    <ul className="flex flex-col gap-4">
      {unreads.data.map((group) => {
        const channel = channels.find((c) => c.id === group.channel_id);
        const last = group.messages.at(-1)!;
        return (
          <li
            key={group.channel_id}
            data-testid="unread-channel"
            className="overflow-hidden rounded-[10px] border border-rule-strong bg-background"
          >
            <header className="flex items-center gap-2 border-b bg-secondary px-4 py-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                {channel ? channelLabel(channel) : ''}
              </h2>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => read.mutate({ channelId: group.channel_id, messageId: last.id })}
              >
                <CheckIcon strokeWidth={1.75} />
                {t('home.markRead')}
              </Button>
            </header>
            <ul className="flex flex-col">
              {group.messages.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="flex w-full gap-3 px-4 py-2 text-start text-sm outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => openMessage(navigate, m)}
                  >
                    <UserAvatar userId={m.author.id} name={m.author.display_name} size="sm" />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex gap-2 text-xs">
                        <span className="font-medium">{m.author.display_name}</span>
                        <time dateTime={m.created_at} className="text-muted-foreground">
                          {time.format(new Date(m.created_at))}
                        </time>
                      </span>
                      <span className="line-clamp-3 break-words">{plainText(m.body)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
