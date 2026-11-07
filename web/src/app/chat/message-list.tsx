// SPDX-License-Identifier: AGPL-3.0-only
import { Body } from '../compliance/encrypted';
import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownIcon, CircleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { toast } from 'sonner';
import { useJump } from './jump';
import { MessageAnnouncer } from './announce-messages';
import { useKeepFocusIn } from './keep-focus';
import { PinnedLine, RepliedToThread, ThreadSummaryButton } from '../threads/thread-summary';
import { ReplyButton } from '../threads/reply-button';
import { PollCard } from '../community/poll';
import { BurnBody } from '../richer/burn';
import { ForwardedQuote } from '../richer/forward';
import { LinkPreviewCard } from '../richer/link-preview';
import { StickerImage } from '../richer/stickers';
import { SubmissionCard, TaskCard } from '../automation/cards';
import { useMessageEnv } from '../richer/message-env';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import {
  flatten,
  isConversation,
  lineOf,
  markRead,
  messagesQuery,
  setReadLocally,
  type Channel,
  type Message,
} from './data';
import { Attachments } from './attachments';
import { ChannelLineRow } from './channel-line';
import { MessageFiles } from './message-files';
import { UserAvatar } from '../profile/avatar';
import { useProfile } from '../profile/profiles';
import { PersonStatus } from '../profile/person-status';
import { ProfileCard } from '../profile/profile-card';
import { BotBadge } from './bot-badge';
import { MessageBody } from './markdown/message-body';
import { MessageActions, MessageEditor } from './message-actions';
import { useMarkUnread } from './mark-unread';
import { EditedLabel } from './edit-history';
import { AckBar, PriorityLabel } from './priority';
import { SeenBy } from './read-receipts';
import { AddReactionButton, ReactionBar } from './reactions';
import { selectOnTap, useSelectedMessage } from './message-select';
import { useEditing } from './message-state';
import { usePending, type PendingMessage } from './pending';
import { useSendMessage } from './send';
import { toRows, useFormatters, type ReadMark, type Row } from './rows';
import { useUnreadHold } from './unread-hold';
import { mentionsMyGroup, useMentionableGroups } from '../groups/groups';

// Virtuoso keeps the scroll position when older pages are prepended if the
// index of the first item decreases by the number of items added.
const START_INDEX = 1_000_000;

export function MessageRow({
  row,
  fmt,
  channel,
  inThread = false,
  repliers,
}: {
  row: Extract<Row, { kind: 'message' }>;
  fmt: ReturnType<typeof useFormatters>;
  channel: Channel;
  /** One's newest message in a conversation: who answered since (for "Seen"). */
  repliers?: string[];
  /** Shown in the thread panel: no thread summary or way into the thread. */
  inThread?: boolean;
}) {
  const { t } = useTranslation();
  const { message: m } = row;
  const self = useSession().user.id;
  const at = new Date(m.created_at);
  const editing = useEditing((s) => s.id === m.id);
  const { role } = useMessageEnv();
  // Mentions of many reach the reader too (not the one who wrote them).
  const reached =
    m.author.id !== self &&
    (m.broadcast ?? []).some(
      (b) =>
        b === 'channel' ||
        b === 'here' ||
        (b === 'role:admin' && (role === 'admin' || role === 'owner')) ||
        (b === 'role:owner' && role === 'owner'),
    );
  const groups = useMentionableGroups(channel.workspace_id);
  const mentionsMe =
    m.mentions.some((p) => p.id === self) ||
    reached ||
    (m.author.id !== self && mentionsMyGroup(m.body, groups));
  const highlighted = useJump((s) => s.highlighted === m.id);
  const hasStatus = !!useProfile(m.author.id)?.status;
  const unread = useMarkUnread(m);
  const selected = useSelectedMessage((s) => s.id === m.id);
  const time = (className?: string) => (
    <time
      dateTime={m.created_at}
      title={fmt.full.format(at)}
      className={cn(
        'text-xs leading-4 tabular-nums',
        mentionsMe ? 'font-semibold text-mention' : 'text-muted-foreground',
        className,
      )}
    >
      {fmt.time.format(at)}
    </time>
  );
  return (
    <div>
      {row.day && (
        <div
          role="separator"
          aria-label={row.day}
          className={cn(SPEAKER_GRID(inThread), 'pt-4 pb-1')}
        >
          <span aria-hidden />
          <span
            aria-hidden
            className="border-b border-border pb-1.5 text-sm font-semibold text-foreground"
          >
            {row.day}
          </span>
        </div>
      )}
      {row.firstUnread && (
        <div
          role="separator"
          aria-label={t('chat.newMessages')}
          data-testid="new-messages"
          className={cn(SPEAKER_GRID(inThread), 'items-center pt-3')}
        >
          <span aria-hidden className="max-sm:hidden" />
          <span className="flex items-center gap-2">
            <span aria-hidden className="h-px flex-1 bg-foreground" />
            <span className="text-xs font-semibold text-foreground">{t('chat.newMessages')}</span>
          </span>
        </div>
      )}
      {/* Alt+click marks the message unread; its menu offers the same. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <article
        aria-labelledby={`m-${m.id}-author`}
        onClick={(e) => {
          if (!e.altKey || m.author.id === self || editing) {
            if (!editing) selectOnTap(e, m.id);
            return;
          }
          e.preventDefault();
          unread.mutate();
        }}
        data-testid="message"
        className={cn(
          'group relative rounded-[10px] hover:bg-hover focus-within:bg-hover',
          SPEAKER_GRID(inThread),
          row.first ? 'pt-2 pb-1' : 'py-0.5',
          (editing || selected) && 'bg-hover',
          highlighted && 'bg-accent',
        )}
        data-mentions-me={mentionsMe || undefined}
        data-highlighted={highlighted || undefined}
        data-message-id={m.id}
        data-selected={selected || undefined}
      >
        {/* The margin holds the speaker's picture on the first message of a
            turn and, on the others, the time when the row is hovered or
            focused. A mention of the reader is marked with "@" and the time in
            red, never by a stripe. */}
        {row.first ? (
          <ProfileCard userId={m.author.id} name={m.author.display_name}>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="mt-0.5 self-start justify-self-start rounded-full outline-none max-sm:hidden"
            >
              <UserAvatar
                userId={m.author.id}
                name={m.author.display_name}
                size={inThread ? 'sm' : 'md'}
              />
            </button>
          </ProfileCard>
        ) : (
          <div className="flex justify-center pt-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-sm:hidden">
            {time('text-[11px] whitespace-nowrap')}
          </div>
        )}
        <div className="min-w-0">
          {row.first ? (
            <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <ProfileCard userId={m.author.id} name={m.author.display_name}>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="shrink-0 self-center rounded-full outline-none sm:hidden"
                >
                  <UserAvatar userId={m.author.id} name={m.author.display_name} size="xs" />
                </button>
              </ProfileCard>
              {mentionsMe && (
                <span className="text-[13px] font-semibold text-mention">
                  <span aria-hidden>@</span>
                  <span className="sr-only">{t('chat.mentionsYou')}</span>
                </span>
              )}
              <ProfileCard userId={m.author.id} name={m.author.display_name}>
                <button
                  type="button"
                  id={`m-${m.id}-author`}
                  className="hit-target flex min-w-0 max-w-full rounded-sm text-[15px] leading-5 font-semibold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="truncate">{m.author.display_name}</span>
                </button>
              </ProfileCard>
              {m.author.is_bot && <BotBadge />}
              {hasStatus && <PersonStatus userId={m.author.id} className="ms-0 text-xs" />}
              {time()}
            </header>
          ) : (
            // Who wrote it, for screen readers: the first message of a turn shows it.
            <header className="sr-only">
              <ProfileCard userId={m.author.id} name={m.author.display_name}>
                <button type="button" id={`m-${m.id}-author`} className="min-h-target">
                  {m.author.display_name}
                </button>
              </ProfileCard>
              <span>{fmt.full.format(at)}</span>
              {mentionsMe && <span>{t('chat.mentionsYou')}</span>}
            </header>
          )}
          <PinnedLine message={m} />
          {!inThread && <RepliedToThread message={m} />}
          {editing ? (
            <MessageEditor message={m} />
          ) : (
            <div className="max-w-[72ch] text-[15px] leading-[1.55] max-sm:text-base">
              {m.title && (
                <p className="text-[0.9375rem] font-semibold" data-testid="post-title">
                  {m.title}
                </p>
              )}
              {!!m.tags?.length && (
                <p className="flex flex-wrap gap-1 py-0.5">
                  {m.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border px-2 text-xs text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </p>
              )}
              <PriorityLabel message={m} />
              {m.burn ? <BurnBody message={m} /> : m.body && <Body message={m} selfId={self} />}
              {m.sticker && <StickerImage sticker={m.sticker} />}
              {m.task && <TaskCard task={m.task} />}
              {m.submission && <SubmissionCard submission={m.submission} />}
              <ForwardedQuote message={m} />
              {m.poll && <PollCard message={m} channel={channel} />}
              <EditedLabel message={m} channel={channel} />
              <Attachments items={m.attachments} selfId={self} message={m} />
              {!channel.mls && <MessageFiles files={m.files} />}
              <LinkPreviewCard message={m} />
              <AckBar message={m} channel={channel} />
              <ReactionBar message={m} canReact={channel.can_react !== false} />
              {!inThread && <ThreadSummaryButton message={m} />}
              {repliers && <SeenBy channel={channel} message={m} repliers={repliers} />}
            </div>
          )}
        </div>
        {!editing && (
          <div
            className={cn(
              'absolute -top-3 end-3 flex gap-0.5 rounded-lg bg-popover p-0.5 opacity-0 shadow-popover transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:static pointer-coarse:justify-self-end sm:pointer-coarse:col-start-2 pointer-coarse:bg-transparent pointer-coarse:opacity-100 pointer-coarse:shadow-none',
              // On touch screens only the tapped message shows its actions.
              !selected && 'pointer-coarse:hidden',
            )}
          >
            {!channel.archived && channel.can_react !== false && <AddReactionButton message={m} />}
            {!inThread && !channel.archived && <ReplyButton message={m} />}
            <MessageActions message={m} channel={channel} inThread={inThread} />
          </div>
        )}
      </article>
    </div>
  );
}

/**
 * The speaker grid of a conversation: the margin column (who and when), a
 * gap, and the words. Narrower in side panels; one column on phones.
 */
export const SPEAKER_GRID = (panel = false) =>
  cn(
    'grid px-3 max-sm:grid-cols-1 max-sm:gap-y-0.5 max-sm:px-4',
    panel
      ? 'grid-cols-[var(--speaker-margin-panel)_minmax(0,1fr)] gap-x-(--margin-gap-panel)'
      : 'grid-cols-[var(--speaker-margin)_minmax(0,1fr)] gap-x-(--margin-gap)',
  );

/** A message of the current user that the server has not confirmed yet. */
export function PendingRow({ p }: { p: PendingMessage }) {
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
      className={cn(SPEAKER_GRID(), 'pt-2 pb-0.5')}
    >
      <UserAvatar userId={user.id} name={name} className="mt-0.5 max-sm:hidden" />
      <div className="min-w-0">
        <header className="flex items-baseline gap-2">
          <span className="text-[15px] leading-5 font-semibold">{name}</span>
          {!failed && <span className="text-xs text-muted-foreground">{t('chat.sending')}</span>}
        </header>
        <div className={cn(!failed && 'text-muted-foreground')}>
          {p.body && <MessageBody body={p.body} mentions={p.mentions ?? []} selfId={user.id} />}
          {p.sticker && <StickerImage sticker={p.sticker} />}
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
              {p.reason ??
                (p.retryAfter ? t('chat.tooFast', { seconds: p.retryAfter }) : t('chat.notSent'))}
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
function useMarkRead(channel: Channel, messages: Message[], held: boolean) {
  const queryClient = useQueryClient();
  const visible = useVisible();
  const [atBottom, setAtBottomState] = useState(true);
  const sent = useRef<string | undefined>(undefined);
  const newest = messages.at(-1)?.id;
  useEffect(() => {
    // Marked unread here: it stays so until the reader leaves.
    if (held) {
      sent.current = undefined;
      return;
    }
    if (!newest || !visible || !atBottom) return;
    if (channel.last_read_id && channel.last_read_id >= newest) return;
    if (sent.current && sent.current >= newest) return;
    sent.current = newest;
    setReadLocally(queryClient, channel.id, newest);
    void markRead(channel.id, newest).catch(() => {
      sent.current = undefined;
    });
  }, [held, newest, visible, atBottom, channel.id, channel.last_read_id, queryClient]);
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
  /** Called with the row of the message once found: the list starts there. */
  onFound: (index: number) => void,
) {
  const { t } = useTranslation();
  const target = useJump((s) => (s.target?.channelId === channelId ? s.target.messageId : null));
  const done = useJump((s) => s.done);
  const { loading, hasNextPage, pages, fetchNextPage } = state;
  // The rows as they are now: pages may still arrive while scrolling.
  const latestRows = useRef(rows);
  useEffect(() => {
    latestRows.current = rows;
  }, [rows]);
  useEffect(() => {
    if (!target || loading) return;
    const index = rows.findIndex((r) => r.kind === 'message' && r.message.id === target);
    if (index >= 0) {
      // The index is in `rows` (not counted from firstItemIndex). The list may
      // still move to keep its place after pages were prepended, so scroll
      // again until the message is in view (a few tries).
      // The highlight starts once the message is in view, so it is seen in full.
      useJump.setState({ target: null });
      // Starting the list at the message is reliable where scrolling a list
      // whose rows are still being measured is not; the loop below checks.
      onFound(index);
      const inView = () => {
        const el = document.querySelector(`[data-message-id="${target}"]`);
        const box = el?.closest('[role="log"]')?.getBoundingClientRect();
        const r = el?.getBoundingClientRect();
        return !!r && !!box && r.top >= box.top && r.bottom <= box.bottom;
      };
      // The highlight lasts 2.6 s from when the message is in view (or from
      // giving up waiting), so a slow device does not use it up beforehand.
      const fade = (waits = 0) => {
        if (!inView() && waits < 50) {
          scroll();
          setTimeout(() => fade(waits + 1), 200);
          return;
        }
        setTimeout(() => {
          if (useJump.getState().highlighted === target) useJump.getState().done(null);
        }, 2600);
      };
      const scroll = () => {
        const now = latestRows.current.findIndex(
          (r) => r.kind === 'message' && r.message.id === target,
        );
        list.current?.scrollToIndex({ index: now >= 0 ? now : index, align: 'center' });
      };
      let tries = 0;
      const bring = () => {
        scroll();
        // A busy device lays the list out slowly: keep trying for up to 10 s.
        if (!inView() && ++tries < 100) {
          setTimeout(bring, 100);
          return;
        }
        done(target);
        fade();
      };
      setTimeout(bring, 50);
      return;
    }
    if (hasNextPage && pages < JUMP_PAGES) {
      void fetchNextPage();
      return;
    }
    done(null);
    toast(t('search.notLoaded'));
  }, [target, rows, loading, hasNextPage, pages, fetchNextPage, list, done, t, onFound]);
}

/** How long after the reader's own scrolling the list counts as moved by them (a busy device
 * delivers scroll events late). */
const USER_SCROLL_MS = 4000;

/** One's newest message in a conversation, and who wrote after it. */
function newestOwnIn(channel: Channel, messages: Message[], self: string) {
  if (!isConversation(channel)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.author.id === self) {
      return { id: messages[i]!.id, repliers: messages.slice(i + 1).map((m) => m.author.id) };
    }
  }
  return undefined;
}

export function MessageList({ channel }: { channel: Channel }) {
  const { id: channelId, name: channelName } = channel;
  const { t } = useTranslation();
  const fmt = useFormatters();
  const query = useInfiniteQuery(messagesQuery(channelId));
  const [logEl, setLogEl] = useState<HTMLDivElement | null>(null);
  useKeepFocusIn(logEl);
  const allPending = usePending((s) => s.items);
  const pending = useMemo(
    () => allPending.filter((p) => p.channelId === channelId && (!p.rootId || p.alsoInChannel)),
    [allPending, channelId],
  );
  const messages = useMemo(() => flatten(query.data), [query.data]);
  const self = useSession().user.id;
  // The list is keyed by channel: this is the read position when it opened,
  // or where the reader marked it unread since.
  const [opened] = useState<ReadMark | undefined>(() =>
    channel.unread_count > 0 ? { after: channel.last_read_id, self } : undefined,
  );
  const hold = useUnreadHold((s) => s.held[channelId]);
  const mark = useMemo(() => (hold ? { ...hold, self } : opened), [hold, opened, self]);
  useEffect(() => () => useUnreadHold.getState().release(channelId), [channelId]);
  const rows = useMemo(
    () => toRows(messages, pending, fmt.day, mark),
    [messages, pending, fmt.day, mark],
  );
  const markAtBottom = useMarkRead(channel, messages, !!hold);
  // One's newest message in a conversation shows who has seen it.
  const lastOwn = newestOwnIn(channel, messages, self);
  const list = useRef<VirtuosoHandle>(null);
  // Whether the reader keeps to the end. Only the reader leaves it (wheel, touch,
  // keys, the scroll bar), or the app jumping to an older message: rows that grow
  // once drawn (pictures, previews, the reader's own messages from another device)
  // keep the list at the end, where Virtuoso's own following would let go.
  const atEnd = useRef(true);
  const userScroll = useRef(0);
  // Until when a jump to an older message is under way: the list mounted at the
  // message may say it is at the end before it has scrolled there.
  const jumping = useRef(0);
  // The newest message when the reader left the end ("" for none): they see a way back.
  const [away, setAway] = useState<string | null>(null);
  const toEnd = useCallback(
    (behavior: 'auto' | 'smooth' = 'auto') =>
      list.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior }),
    [],
  );
  const setAtBottom = useCallback(
    (bottom: boolean) => {
      markAtBottom(bottom);
      if (bottom) {
        if (Date.now() < jumping.current) return;
        atEnd.current = true;
        setAway(null);
      } else if (Date.now() - userScroll.current < USER_SCROLL_MS || !atEnd.current) {
        atEnd.current = false;
        setAway(messages.at(-1)?.id ?? '');
      } else {
        // A row grew under the reader: back to the end.
        toEnd();
      }
    },
    [markAtBottom, toEnd, messages],
  );
  useEffect(() => {
    if (!logEl) return;
    const moved = () => (userScroll.current = Date.now());
    const keys = (e: KeyboardEvent) => {
      if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(e.key)) moved();
    };
    const events = ['wheel', 'touchmove', 'pointerdown'] as const;
    for (const e of events) logEl.addEventListener(e, moved, { passive: true });
    logEl.addEventListener('keydown', keys);
    return () => {
      for (const e of events) logEl.removeEventListener(e, moved);
      logEl.removeEventListener('keydown', keys);
    };
  }, [logEl]);
  const rowCount = rows.length;
  useLayoutEffect(() => {
    if (!atEnd.current || rowCount === 0) return;
    toEnd();
    // Again once the new row is measured (its height is known only after paint).
    const frame = requestAnimationFrame(() => toEnd());
    return () => cancelAnimationFrame(frame);
  }, [rowCount, toEnd]);
  // Messages of others that came while the reader was away from the end.
  const fresh =
    away === null
      ? 0
      : messages
          .slice(messages.findIndex((m) => m.id === away) + 1)
          .filter((m) => m.author.id !== self && !lineOf(m)).length;

  // Prepending older messages lowers the index of the first row by exactly the
  // rows added before the oldest message of the newest page (its anchor): day
  // separators move, so counting messages alone would shift the list by a row.
  const olderCount = useMemo(
    () => (query.data ? query.data.pages.slice(1).reduce((n, p) => n + p.messages.length, 0) : 0),
    [query.data],
  );
  const anchorId = query.data?.pages[0]?.messages[0]?.id;
  const firstItemIndex = useMemo(() => {
    const at = anchorId
      ? rows.findIndex((r) => r.kind === 'message' && r.message.id === anchorId)
      : -1;
    return START_INDEX - (at >= 0 ? at : olderCount);
  }, [rows, anchorId, olderCount]);

  // A jump starts the list again at the message (a new key mounts it there).
  const [startAt, setStartAt] = useState<{ index: number; seq: number } | null>(null);
  const onFound = useCallback(
    (index: number) => {
      // The reader goes to an older message: the list no longer keeps to the end.
      atEnd.current = false;
      jumping.current = Date.now() + 3000;
      setAway(messages.at(-1)?.id ?? '');
      setStartAt((s) => ({ index, seq: (s?.seq ?? 0) + 1 }));
    },
    [messages],
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
    onFound,
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
      ref={setLogEl}
      role="log"
      aria-live="off"
      aria-label={t('chat.messagesIn', { channel: channelName })}
      tabIndex={-1}
      className="relative min-h-0 flex-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <MessageAnnouncer messages={messages} selfId={self} />
      <Virtuoso
        key={startAt?.seq ?? 0}
        ref={list}
        className="h-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        data={rows}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={
          startAt
            ? { index: Math.min(startAt.index, rows.length - 1), align: 'center' }
            : Math.max(rows.length - 1, 0)
        }
        computeItemKey={(_, row) => row.key}
        // Stay at the bottom when new messages arrive, if the reader is there.
        followOutput={(atBottom) => (atBottom ? 'auto' : false)}
        atBottomStateChange={setAtBottom}
        totalListHeightChanged={() => {
          // Rows measured while the reader scrolls change the height too: not a reason to pull back.
          if (atEnd.current && Date.now() - userScroll.current > USER_SCROLL_MS) toEnd();
        }}
        // "At the end" with a little slack, so a row still growing does not let go.
        atBottomThreshold={48}
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
          row.kind === 'message' && lineOf(row.message) ? (
            <ChannelLineRow row={row} line={lineOf(row.message)!} fmt={fmt} grid={SPEAKER_GRID()} />
          ) : row.kind === 'message' ? (
            <MessageRow
              row={row}
              fmt={fmt}
              channel={channel}
              repliers={row.message.id === lastOwn?.id ? lastOwn.repliers : undefined}
            />
          ) : (
            <PendingRow p={row.pending} />
          )
        }
      />
      {away !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="sm"
            variant="secondary"
            className="pointer-events-auto rounded-full shadow-md"
            data-testid="jump-latest"
            aria-label={
              fresh > 0 ? t('chat.jumpLatestNew', { count: fresh }) : t('chat.jumpLatest')
            }
            onClick={() => {
              atEnd.current = true;
              userScroll.current = 0;
              jumping.current = 0;
              setAway(null);
              const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
              toEnd(reduce ? 'auto' : 'smooth');
              // Rows measured on the way change the height: land exactly at the end.
              if (!reduce) window.setTimeout(() => atEnd.current && toEnd(), 450);
            }}
          >
            <ArrowDownIcon aria-hidden className="size-4" strokeWidth={1.75} />
            {fresh > 0 ? t('chat.newBelow', { count: fresh }) : t('chat.jumpLatest')}
          </Button>
        </div>
      )}
    </div>
  );
}
