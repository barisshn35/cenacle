// SPDX-License-Identifier: AGPL-3.0-only
import { SummarizeButton } from '../ai/ai-ui';
import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon, BellOffIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { useLayout, type ThreadTarget } from '../../stores/layout';
import { Composer } from '../chat/composer';
import { channelsQuery, flatten, messageQuery, repliesQuery, type Channel } from '../chat/data';
import { MessageRow, PendingRow } from '../chat/message-list';
import { toRows, useFormatters } from '../chat/rows';
import { usePending } from '../chat/pending';
import { threadKey, useUnreadHold } from '../chat/unread-hold';
import { useSession } from '../auth/session';
import { markThreadRead, setFollowing, threadFollowQuery, threadsChanged } from './threads';

/** The right panel's thread: its first message, the replies and a composer. */
export function ThreadPanel() {
  const { t } = useTranslation();
  const target = useLayout((s) => s.thread);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const channel = useQuery(channelsQuery).data?.find((c) => c.id === target?.channelId);
  return (
    <aside
      aria-labelledby="thread-title"
      className="flex h-full flex-col border-l bg-background"
      data-testid="thread-panel"
    >
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 id="thread-title" className="text-sm font-semibold">
            {t('threads.title')}
          </h2>
          {channel && (
            <span className="truncate text-xs text-muted-foreground">
              {channel.kind === 'direct' || channel.kind === 'group'
                ? channel.name
                : `#${channel.name}`}
            </span>
          )}
        </div>
        {target && channel && !channel.encrypted && (
          <SummarizeButton channelId={channel.id} rootId={target.rootId} />
        )}
        {target && <FollowButton rootId={target.rootId} />}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('threads.close')}
          onClick={() => setDetailsOpen(false)}
        >
          <XIcon strokeWidth={1.75} />
        </Button>
      </header>
      {target && channel ? (
        <Thread key={target.rootId} target={target} channel={channel} />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">{t('threads.unavailable')}</p>
      )}
    </aside>
  );
}

function FollowButton({ rootId }: { rootId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const follow = useQuery(threadFollowQuery(rootId));
  const following = follow.data?.following ?? false;
  const change = useMutation({
    mutationFn: (on: boolean) => setFollowing(rootId, on),
    onMutate: (on) =>
      queryClient.setQueryData(threadFollowQuery(rootId).queryKey, (d) =>
        d ? { ...d, following: on } : { following: on, last_read_id: null },
      ),
    onSuccess: () => threadsChanged(queryClient),
    onError: () => {
      toast.error(t('threads.followFailed'));
      void queryClient.invalidateQueries({ queryKey: threadFollowQuery(rootId).queryKey });
    },
  });
  if (!follow.data) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={following}
      onClick={() => change.mutate(!following)}
    >
      {following ? <BellOffIcon strokeWidth={1.75} /> : <BellIcon strokeWidth={1.75} />}
      {following ? t('threads.unfollow') : t('threads.follow')}
    </Button>
  );
}

function Thread({ target, channel }: { target: ThreadTarget; channel: Channel }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fmt = useFormatters();
  const root = useQuery(messageQuery(queryClient, target.channelId, target.rootId));
  const replies = useInfiniteQuery(repliesQuery(target.channelId, target.rootId));
  const follow = useQuery(threadFollowQuery(target.rootId));
  const allPending = usePending((s) => s.items);
  const pending = useMemo(
    () => allPending.filter((p) => p.rootId === target.rootId),
    [allPending, target.rootId],
  );
  const messages = useMemo(() => flatten(replies.data), [replies.data]);
  // Marked unread here: the replies from there on show as new, and stay unread
  // while the thread is open.
  const self = useSession().user.id;
  const holdKey = threadKey(target.rootId);
  const hold = useUnreadHold((s) => s.held[holdKey]);
  useEffect(() => () => useUnreadHold.getState().release(holdKey), [holdKey]);
  const rows = useMemo(
    () => toRows(messages, pending, fmt.day, hold ? { ...hold, self } : undefined),
    [messages, pending, fmt.day, hold, self],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Open at the latest reply and stay there as replies arrive, if the reader is there.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, root.data]);

  // Reading the thread moves the read position of a followed thread.
  const last = messages.at(-1);
  const lastRead = follow.data?.last_read_id;
  const following = follow.data?.following;
  useEffect(() => {
    if (hold || !following || !last || (lastRead && lastRead >= last.id)) return;
    if (document.visibilityState !== 'visible') return;
    queryClient.setQueryData(threadFollowQuery(target.rootId).queryKey, (d) =>
      d ? { ...d, last_read_id: last.id } : d,
    );
    void markThreadRead(target.rootId, last.id)
      .then(() => threadsChanged(queryClient))
      .catch(() => undefined);
  }, [hold, following, last, lastRead, queryClient, target.rootId]);

  if (root.isError) {
    return (
      <div className="p-4">
        {root.error instanceof ApiError && root.error.status === 404 ? (
          <p className="text-sm text-muted-foreground">{t('threads.unavailable')}</p>
        ) : (
          <ErrorState
            problem={root.error instanceof ApiError ? root.error.problem : { status: 500 }}
            actions={<Button onClick={() => void root.refetch()}>{t('ui:errors.retry')}</Button>}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div
        ref={scroller}
        role="log"
        aria-label={t('threads.repliesIn', { channel: channel.name })}
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {root.data ? (
          <MessageRow
            row={{ kind: 'message', key: root.data.id, message: root.data, first: true }}
            fmt={fmt}
            channel={channel}
            inThread
          />
        ) : (
          <Skeleton className="m-4 h-12" />
        )}
        <div role="separator" className="flex items-center gap-3 px-4 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t('threads.replies', { count: root.data?.thread?.reply_count ?? messages.length })}
          </span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
        {replies.hasNextPage && (
          <div className="flex justify-center py-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={replies.isFetchingNextPage}
              onClick={() => {
                atBottom.current = false;
                void replies.fetchNextPage();
              }}
            >
              {t('threads.older')}
            </Button>
          </div>
        )}
        {replies.isPending ? (
          <Skeleton className="mx-4 h-10" />
        ) : (
          rows.map((row) =>
            row.kind === 'message' ? (
              <MessageRow key={row.key} row={row} fmt={fmt} channel={channel} inThread />
            ) : (
              <PendingRow key={row.key} p={row.pending} />
            ),
          )
        )}
      </div>
      {channel.archived || !channel.can_post ? (
        <p className="m-3 rounded-[10px] border border-dashed border-rule-strong px-3 py-2 text-sm text-muted-foreground">
          {t('threads.readOnly')}
        </p>
      ) : (
        <Composer
          key={`thread-${target.rootId}`}
          channelId={channel.id}
          channelName={channel.name}
          thread={{ rootId: target.rootId }}
        />
      )}
    </>
  );
}
