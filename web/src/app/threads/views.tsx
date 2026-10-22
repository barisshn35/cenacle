// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  AtSignIcon,
  BellRingIcon,
  CheckIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  SmileIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { SidebarTrigger } from '@cenacle/ui/components/sidebar';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { useLayout } from '../../stores/layout';
import { useActiveWorkspace } from '../chat/active-workspace';
import { channelsQuery, markRead, setReadLocally, type Message } from '../chat/data';
import { openMessage } from './open-message';
import { EventsList } from '../community/events';
import { PlaybooksList } from '../community/playbooks';
import { WorkflowsPage } from '../automation/workflows-page';
import { MyTasks } from '../collab/my-tasks';
import { CompliancePage } from '../compliance/compliance-page';
import { UserAvatar } from '../profile/avatar';
import { plainText } from '../search/search';
import {
  activityQuery,
  applySaved,
  followedThreadsQuery,
  savedQuery,
  saveMessage,
  unreadsQuery,
  unsaveMessage,
  type ActivityItem,
  type SavedItem,
} from './threads';

export type HomeView =
  | 'threads'
  | 'activity'
  | 'saved'
  | 'unreads'
  | 'tasks'
  | 'events'
  | 'playbooks'
  | 'workflows'
  | 'compliance';

function channelLabel(c: { name: string; kind: string }) {
  return c.kind === 'direct' || c.kind === 'group' ? c.name : `#${c.name}`;
}

/** The name the person sees for a channel (conversations are named after people). */
function useChannelNames() {
  const channels = useQuery(channelsQuery).data;
  return (c: { id: string; name: string; kind: string }) =>
    channelLabel({ ...c, name: channels?.find((x) => x.id === c.id)?.name ?? c.name });
}

function Shell({
  title,
  mobile,
  children,
}: {
  title: string;
  mobile: boolean;
  children: ReactNode;
}) {
  return (
    <main className="flex h-full min-w-0 flex-col bg-background" aria-labelledby="view-title">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        {mobile && <SidebarTrigger />}
        <h1 id="view-title" className="text-[0.9375rem] font-semibold">
          {title}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 p-4">{children}</div>
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

const cardClass =
  'flex w-full flex-col gap-1 rounded-xl border bg-card px-4 py-3 text-left text-sm outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50';

export function HomeViewPage({ view, mobile = false }: { view: HomeView; mobile?: boolean }) {
  const { t } = useTranslation();
  return (
    <Shell title={t(`home.${view}`)} mobile={mobile}>
      {view === 'threads' && <ThreadsList />}
      {view === 'activity' && <ActivityList />}
      {view === 'saved' && <SavedList />}
      {view === 'unreads' && <UnreadsList />}
      {view === 'tasks' && <MyTasks />}
      {view === 'events' && <EventsList />}
      {view === 'playbooks' && <PlaybooksList />}
      {view === 'workflows' && <WorkflowsPage />}
      {view === 'compliance' && <CompliancePage />}
    </Shell>
  );
}

function ThreadsList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const ws = useActiveWorkspace().id;
  const name = useChannelNames();
  const list = useInfiniteQuery(followedThreadsQuery(ws));
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  if (list.isPending) return <Loading />;
  if (list.isError) return <Problem error={list.error} retry={() => void list.refetch()} />;
  const threads = list.data.pages.flatMap((p) => p.threads);
  if (threads.length === 0) return <Empty>{t('home.noThreads')}</Empty>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {threads.map((th) => (
          <li key={th.root.id}>
            <button
              type="button"
              data-testid="followed-thread"
              data-unread={th.unread_count > 0 || undefined}
              className={cardClass}
              onClick={() => {
                void navigate({ to: '/c/$channelId', params: { channelId: th.channel.id } });
                useLayout.getState().openThread({ channelId: th.channel.id, rootId: th.root.id });
              }}
            >
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate">{name(th.channel)}</span>
                {th.root.thread && (
                  <span className="ml-auto shrink-0">
                    {time.format(new Date(th.root.thread.last_reply_at))}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <UserAvatar
                  userId={th.root.author.id}
                  name={th.root.author.display_name}
                  size="sm"
                />
                <span className="font-medium">{th.root.author.display_name}</span>
              </span>
              <span className="line-clamp-2 break-words">{plainText(th.root.body)}</span>
              <span className="flex items-center gap-2 text-xs">
                <MessageSquareIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                <span className="text-muted-foreground">
                  {t('threads.replies', { count: th.root.thread?.reply_count ?? 0 })}
                </span>
                {th.unread_count > 0 && (
                  <span
                    className={
                      th.mention_count > 0
                        ? 'rounded-full bg-mention px-2 font-semibold text-mention-foreground'
                        : 'font-semibold text-unread'
                    }
                  >
                    {th.mention_count > 0
                      ? t('mentions.unread', { count: th.mention_count })
                      : t('threads.newReplies', { count: th.unread_count })}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
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

const ACTIVITY_ICONS = {
  mention: AtSignIcon,
  reply: MessageSquareIcon,
  reaction: SmileIcon,
} as const;

function ActivityList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const ws = useActiveWorkspace().id;
  const name = useChannelNames();
  const list = useInfiniteQuery(activityQuery(ws));
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  if (list.isPending) return <Loading />;
  if (list.isError) return <Problem error={list.error} retry={() => void list.refetch()} />;
  const items: ActivityItem[] = list.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <Empty>{t('home.noActivity')}</Empty>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {items.map((a) => {
          const Icon = ACTIVITY_ICONS[a.kind];
          return (
            <li key={`${a.kind}-${a.message.id}-${a.actor.id}-${a.emoji}`}>
              <button
                type="button"
                data-testid="activity"
                className={cardClass}
                onClick={() => openMessage(navigate, a.message)}
              >
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
                  <span className="truncate">
                    {t(`home.activity_${a.kind}`, {
                      name: a.actor.display_name,
                      channel: name(a.channel),
                      emoji: a.emoji,
                    })}
                  </span>
                  <time dateTime={a.at} className="ml-auto shrink-0">
                    {time.format(new Date(a.at))}
                  </time>
                </span>
                <span className="line-clamp-2 break-words">{plainText(a.message.body)}</span>
              </button>
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

function SavedList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const name = useChannelNames();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const saved = useQuery(savedQuery);
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
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
  const items = saved.data.filter((s) => (tab === 'done') === !!s.done_at);
  return (
    <>
      <div role="tablist" aria-label={t('home.saved')} className="flex gap-1">
        {(['open', 'done'] as const).map((k) => (
          <Button
            key={k}
            role="tab"
            size="sm"
            variant={tab === k ? 'secondary' : 'ghost'}
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {t(`saved.tabs.${k}`)}
          </Button>
        ))}
      </div>
      {items.length === 0 ? (
        <Empty>{tab === 'open' ? t('saved.none') : t('saved.noneDone')}</Empty>
      ) : (
        <div role="tabpanel">
          <ul className="flex flex-col gap-2">
            {items.map((s) => (
              <li
                key={s.message.id}
                data-testid="saved-item"
                className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-sm"
              >
                <button
                  type="button"
                  className="flex flex-col gap-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => openMessage(navigate, s.message)}
                >
                  <span className="flex gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{name(s.channel)}</span>
                    <span>·</span>
                    <span className="truncate">{s.message.author.display_name}</span>
                  </span>
                  <span className="line-clamp-3 break-words">{plainText(s.message.body)}</span>
                </button>
                {s.remind_at && !s.done_at && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <BellRingIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                    {t('saved.remindAt', { time: time.format(new Date(s.remind_at)) })}
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  {!s.done_at && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                        <BellRingIcon strokeWidth={1.75} />
                        {t('saved.remind')}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {REMINDERS.map((r) => (
                          <DropdownMenuItem
                            key={r}
                            onClick={() =>
                              change.mutate({ item: s, state: { remind_at: remindAt(r) } })
                            }
                          >
                            {t(`saved.reminders.${r}`)}
                          </DropdownMenuItem>
                        ))}
                        {s.remind_at && (
                          <DropdownMenuItem
                            onClick={() => change.mutate({ item: s, state: { remind_at: null } })}
                          >
                            {t('saved.noReminder')}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      change.mutate({
                        item: s,
                        state: s.done_at ? { remind_at: null } : { done: true },
                      })
                    }
                  >
                    {s.done_at ? (
                      <RotateCcwIcon strokeWidth={1.75} />
                    ) : (
                      <CheckIcon strokeWidth={1.75} />
                    )}
                    {s.done_at ? t('saved.undoDone') : t('saved.markDone')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => change.mutate({ item: s, state: null })}
                  >
                    <Trash2Icon strokeWidth={1.75} />
                    {t('saved.remove')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
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
  const time = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' });
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
          <li key={group.channel_id} data-testid="unread-channel" className="rounded-xl border">
            <header className="flex items-center gap-2 border-b px-4 py-2">
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
                    className="flex w-full gap-3 px-4 py-2 text-left text-sm outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
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
