// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { toast } from 'sonner';
import { useJump } from './jump';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import {
  flatten,
  markRead,
  messagesQuery,
  setReadLocally,
  type Channel,
  type Message,
} from './data';
import { Attachments } from './attachments';
import { MessageFiles } from './message-files';
import { UserAvatar } from '../profile/avatar';
import { PersonStatus } from '../profile/person-status';
import { ProfileCard } from '../profile/profile-card';
import { BotBadge } from './bot-badge';
import { MessageBody } from './markdown/message-body';
import { MessageActions, MessageEditor } from './message-actions';
import { AddReactionButton, ReactionBar } from './reactions';
import { useEditing } from './message-state';
import { usePending, type PendingMessage } from './pending';
import { useSendMessage } from './send';

/** A row of the timeline: a confirmed or a pending message. */
type Row =
  | {
      kind: 'message';
      key: string;
      message: Message;
      first: boolean;
      day?: string;
      /** The first message that was unread when the channel opened. */
      firstUnread?: boolean;
    }
  | { kind: 'pending'; key: string; pending: PendingMessage };

/** Consecutive messages of one author within 5 minutes share a header. */
const GROUP_MS = 5 * 60_000;

// Virtuoso keeps the scroll position when older pages are prepended if the
// index of the first item decreases by the number of items added.
const START_INDEX = 1_000_000;

function useFormatters() {
  const { i18n } = useTranslation();
  return useMemo(
    () => ({
      time: new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }),
      day: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full' }),
      full: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    }),
    [i18n.language],
  );
}

/** Where reading stood when the channel opened, if anything was unread then. */
interface ReadMark {
  after: string | null;
  self: string;
}

function toRows(
  messages: Message[],
  pending: PendingMessage[],
  dayFmt: Intl.DateTimeFormat,
  mark: ReadMark | undefined,
): Row[] {
  const rows: Row[] = [];
  let prev: Message | undefined;
  let marked = !mark;
  for (const m of messages) {
    const firstUnread =
      !marked && m.author.id !== mark!.self && (mark!.after === null || m.id > mark!.after);
    if (firstUnread) marked = true;
    const at = new Date(m.created_at);
    const day = dayFmt.format(at);
    const newDay = !prev || dayFmt.format(new Date(prev.created_at)) !== day;
    const first =
      newDay ||
      prev!.author.id !== m.author.id ||
      at.getTime() - new Date(prev!.created_at).getTime() > GROUP_MS;
    rows.push({
      kind: 'message',
      key: m.id,
      message: m,
      first: first || firstUnread,
      day: newDay ? day : undefined,
      firstUnread,
    });
    prev = m;
  }
  for (const p of pending) rows.push({ kind: 'pending', key: p.nonce, pending: p });
  return rows;
}

function MessageRow({
  row,
  fmt,
  channel,
}: {
  row: Extract<Row, { kind: 'message' }>;
  fmt: ReturnType<typeof useFormatters>;
  channel: Channel;
}) {
  const { t } = useTranslation();
  const { message: m } = row;
  const self = useSession().user.id;
  const at = new Date(m.created_at);
  const editing = useEditing((s) => s.id === m.id);
  const mentionsMe = m.mentions.some((p) => p.id === self);
  const highlighted = useJump((s) => s.highlighted === m.id);
  return (
    <div>
      {row.day && (
        <div
          role="separator"
          aria-label={row.day}
          className="flex items-center gap-3 px-4 pt-4 pb-1"
        >
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span className="text-xs font-medium text-muted-foreground">{row.day}</span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      )}
      {row.firstUnread && (
        <div
          role="separator"
          aria-label={t('chat.newMessages')}
          data-testid="new-messages"
          className="flex items-center gap-3 px-4 pt-3"
        >
          <span aria-hidden className="h-px flex-1 bg-unread/40" />
          <span className="text-xs font-semibold text-unread">{t('chat.newMessages')}</span>
          <span aria-hidden className="h-px flex-1 bg-unread/40" />
        </div>
      )}
      <article
        aria-labelledby={`m-${m.id}-author`}
        data-testid="message"
        className={cn(
          'group relative flex gap-3 px-4 hover:bg-muted/40 focus-within:bg-muted/40',
          row.first ? 'pt-3 pb-0.5' : 'py-0.5',
          editing && 'bg-muted/40',
          highlighted && 'bg-accent',
          // A message for the reader: tinted and marked at the edge (not by color alone:
          // the mention chip in the text says it too).
          mentionsMe &&
            'border-l-3 border-l-mention bg-mention-bg/60 pl-[13px] hover:bg-mention-bg',
        )}
        data-mentions-me={mentionsMe || undefined}
        data-highlighted={highlighted || undefined}
        data-message-id={m.id}
      >
        {row.first ? (
          <ProfileCard userId={m.author.id} name={m.author.display_name}>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="h-9 shrink-0 self-start rounded-full outline-none"
            >
              <UserAvatar userId={m.author.id} name={m.author.display_name} />
            </button>
          </ProfileCard>
        ) : (
          <span className="w-9 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <header className={cn('flex items-baseline gap-2', !row.first && 'sr-only')}>
            <ProfileCard userId={m.author.id} name={m.author.display_name}>
              <button
                type="button"
                id={`m-${m.id}-author`}
                className="inline-flex min-h-target items-center rounded-sm text-sm font-semibold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {m.author.display_name}
              </button>
            </ProfileCard>
            <PersonStatus userId={m.author.id} className="ml-0 text-xs" />
            {m.author.is_bot && <BotBadge />}
            <time
              dateTime={m.created_at}
              title={fmt.full.format(at)}
              className="text-xs text-muted-foreground"
            >
              {fmt.time.format(at)}
            </time>
          </header>
          {editing ? (
            <MessageEditor message={m} />
          ) : (
            <>
              {m.body && <MessageBody body={m.body} mentions={m.mentions} selfId={self} />}
              {m.edited_at && (
                <span
                  className="text-xs text-muted-foreground"
                  title={fmt.full.format(new Date(m.edited_at))}
                >
                  {t('chat.edited')}
                </span>
              )}
              <Attachments items={m.attachments} selfId={self} />
              <MessageFiles files={m.files} />
              <ReactionBar message={m} />
            </>
          )}
        </div>
        {!editing && (
          <div className="absolute top-0.5 right-3 flex gap-0.5">
            {!channel.archived && (
              <AddReactionButton
                message={m}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100"
              />
            )}
            <MessageActions message={m} channel={channel} />
          </div>
        )}
      </article>
    </div>
  );
}

/** A message of the current user that the server has not confirmed yet. */
function PendingRow({ p }: { p: PendingMessage }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const { retry, discard } = useSendMessage();
  const failed = p.status === 'failed';
  const name = user.display_name || user.email;
  return (
    <article
      data-testid="pending-message"
      aria-busy={!failed}
      aria-label={name}
      className="flex gap-3 px-4 pt-3 pb-0.5"
    >
      <UserAvatar userId={user.id} name={name} />
      <div className="min-w-0 flex-1">
        <header className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{name}</span>
          {!failed && <span className="text-xs text-muted-foreground">{t('chat.sending')}</span>}
        </header>
        <div className={cn(!failed && 'text-muted-foreground')}>
          {p.body && <MessageBody body={p.body} mentions={p.mentions ?? []} selfId={user.id} />}
          {p.files && p.files.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1.5 text-sm" aria-label={t('files.attached')}>
              {p.files.map((f) => (
                <li key={f.id} className="rounded-md border px-2 py-1">
                  {f.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        {failed ? (
          <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <CircleAlertIcon aria-hidden className="size-4 text-destructive" strokeWidth={1.75} />
            <span>
              {p.retryAfter ? t('chat.tooFast', { seconds: p.retryAfter }) : t('chat.notSent')}
            </span>
            <Button size="sm" variant="outline" onClick={() => void retry(p)}>
              {t('chat.retry')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => discard(p.nonce)}>
              {t('chat.discard')}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Loading() {
  return (
    <div aria-hidden className="flex flex-col gap-5 px-4 py-6">
      {[72, 48, 88, 60].map((w, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-9 shrink-0 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2 pt-0.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Whether the document is shown (not a background tab). */
function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/**
 * Marks the channel read up to its newest message while the reader is at the
 * bottom of a visible tab.
 */
function useMarkRead(channel: Channel, messages: Message[]) {
  const queryClient = useQueryClient();
  const visible = useVisible();
  const [atBottom, setAtBottomState] = useState(true);
  const sent = useRef<string | undefined>(undefined);
  const newest = messages.at(-1)?.id;
  useEffect(() => {
    if (!newest || !visible || !atBottom) return;
    if (channel.last_read_id && channel.last_read_id >= newest) return;
    if (sent.current && sent.current >= newest) return;
    sent.current = newest;
    setReadLocally(queryClient, channel.id, newest);
    void markRead(channel.id, newest).catch(() => {
      sent.current = undefined;
    });
  }, [newest, visible, atBottom, channel.id, channel.last_read_id, queryClient]);
  return setAtBottomState;
}

/** The timeline of a channel: newest at the bottom, older pages load on scroll up. */
/** Older pages loaded at most while looking for a message to jump to. */
const JUMP_PAGES = 40;

/**
 * Brings the message asked for (a search result) into view: loads older pages
 * until it is there, then scrolls to it and highlights it for a moment.
 */
function useJumpTo(
  channelId: string,
  rows: Row[],
  state: {
    loading: boolean;
    hasNextPage: boolean;
    pages: number;
    fetchNextPage: () => Promise<unknown>;
  },
  list: RefObject<VirtuosoHandle | null>,
) {
  const { t } = useTranslation();
  const target = useJump((s) => (s.target?.channelId === channelId ? s.target.messageId : null));
  const done = useJump((s) => s.done);
  const { loading, hasNextPage, pages, fetchNextPage } = state;
  useEffect(() => {
    if (!target || loading) return;
    const index = rows.findIndex((r) => r.kind === 'message' && r.message.id === target);
    if (index >= 0) {
      // The index is in `rows` (not counted from firstItemIndex). The list may
      // still move to keep its place after pages were prepended, so scroll
      // again until the message is in view (a few tries).
      let tries = 0;
      const bring = () => {
        list.current?.scrollToIndex({ index, align: 'center' });
        const el = document.querySelector(`[data-message-id="${target}"]`);
        const box = el?.closest('[role="log"]')?.getBoundingClientRect();
        const r = el?.getBoundingClientRect();
        const inView = !!r && !!box && r.top >= box.top && r.bottom <= box.bottom;
        if (!inView && ++tries < 20) setTimeout(bring, 100);
      };
      setTimeout(bring, 50);
      done(target);
      setTimeout(() => {
        if (useJump.getState().highlighted === target) useJump.getState().done(null);
      }, 2600);
      return;
    }
    if (hasNextPage && pages < JUMP_PAGES) {
      void fetchNextPage();
      return;
    }
    done(null);
    toast(t('search.notLoaded'));
  }, [target, rows, loading, hasNextPage, pages, fetchNextPage, list, done, t]);
}

export function MessageList({ channel }: { channel: Channel }) {
  const { id: channelId, name: channelName } = channel;
  const { t } = useTranslation();
  const fmt = useFormatters();
  const query = useInfiniteQuery(messagesQuery(channelId));
  const allPending = usePending((s) => s.items);
  const pending = useMemo(
    () => allPending.filter((p) => p.channelId === channelId),
    [allPending, channelId],
  );
  const messages = useMemo(() => flatten(query.data), [query.data]);
  const self = useSession().user.id;
  // The list is keyed by channel: this is the read position when it opened.
  const [mark] = useState<ReadMark | undefined>(() =>
    channel.unread_count > 0 ? { after: channel.last_read_id, self } : undefined,
  );
  const rows = useMemo(
    () => toRows(messages, pending, fmt.day, mark),
    [messages, pending, fmt.day, mark],
  );
  const setAtBottom = useMarkRead(channel, messages);
  const list = useRef<VirtuosoHandle>(null);

  // Prepending older messages lowers the index of the first row.
  const olderCount = useMemo(
    () => (query.data ? query.data.pages.slice(1).reduce((n, p) => n + p.messages.length, 0) : 0),
    [query.data],
  );

  useJumpTo(
    channelId,
    rows,
    {
      loading: query.isPending || query.isFetchingNextPage,
      hasNextPage: query.hasNextPage,
      pages: query.data?.pages.length ?? 0,
      fetchNextPage: query.fetchNextPage,
    },
    list,
  );

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <ErrorState
          problem={query.error instanceof ApiError ? query.error.problem : { status: 500 }}
          actions={<Button onClick={() => void query.refetch()}>{t('ui:errors.retry')}</Button>}
        />
      </div>
    );
  }

  const intro = (
    <div className="flex flex-col gap-1 px-4 pt-8 pb-4">
      <p className="font-display text-2xl font-medium">
        {channel.kind === 'direct' || channel.kind === 'group'
          ? t('dm.intro', { people: channelName })
          : t('shell.channelStart', { channel: channelName })}
      </p>
      <p className="text-sm text-muted-foreground">{t('chat.channelIntro')}</p>
    </div>
  );

  return (
    <div
      role="log"
      aria-label={t('chat.messagesIn', { channel: channelName })}
      className="min-h-0 flex-1"
    >
      <Virtuoso
        ref={list}
        className="h-full"
        data={rows}
        firstItemIndex={START_INDEX - olderCount}
        initialTopMostItemIndex={Math.max(rows.length - 1, 0)}
        computeItemKey={(_, row) => row.key}
        // Stay at the bottom when new messages arrive, if the reader is there.
        followOutput={(atBottom) => (atBottom ? 'smooth' : false)}
        atBottomStateChange={setAtBottom}
        alignToBottom
        startReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
        }}
        components={{
          Header: () =>
            query.hasNextPage ? (
              <div className="flex justify-center py-3 text-xs text-muted-foreground">
                {query.isFetchingNextPage ? t('chat.loadingOlder') : ''}
              </div>
            ) : (
              intro
            ),
          Footer: () => <div className="h-3" />,
        }}
        itemContent={(_, row) =>
          row.kind === 'message' ? (
            <MessageRow row={row} fmt={fmt} channel={channel} />
          ) : (
            <PendingRow p={row.pending} />
          )
        }
      />
    </div>
  );
}
