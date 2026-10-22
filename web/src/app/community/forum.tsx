// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquareIcon, PlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { cn } from '@cenacle/ui/lib/utils';
import { useLayout } from '../../stores/layout';
import { addMessage, flatten, messagesQuery, type Channel, type Message } from '../chat/data';
import { newNonce } from '../chat/pending';
import { UserAvatar } from '../profile/avatar';
import { plainText } from '../search/search';

const lastActivity = (m: Message) => m.thread?.last_reply_at ?? m.created_at;

/** A forum: its posts, latest activity first, filtered by tag; a post opens as a thread. */
export function ForumView({ channel }: { channel: Channel }) {
  const { t, i18n } = useTranslation();
  const openThread = useLayout((s) => s.openThread);
  const posts = useInfiniteQuery(messagesQuery(channel.id));
  const [tag, setTag] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const list = useMemo(
    () =>
      flatten(posts.data)
        .filter((m) => !m.root_id && (!tag || m.tags?.includes(tag)))
        .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a))),
    [posts.data, tag],
  );
  const tags = channel.forum_tags ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="forum">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {tags.length > 0 && (
            <div
              role="group"
              aria-label={t('community.forum.filter')}
              className="flex flex-wrap gap-1"
            >
              <Button
                size="sm"
                variant={tag === null ? 'secondary' : 'ghost'}
                aria-pressed={tag === null}
                onClick={() => setTag(null)}
              >
                {t('community.forum.all')}
              </Button>
              {tags.map((x) => (
                <Button
                  key={x}
                  size="sm"
                  variant={tag === x ? 'secondary' : 'ghost'}
                  aria-pressed={tag === x}
                  onClick={() => setTag(x)}
                >
                  {x}
                </Button>
              ))}
            </div>
          )}
          {channel.can_post && !channel.archived && (
            <Button className="ml-auto" onClick={() => setWriting(true)}>
              <PlusIcon strokeWidth={1.75} />
              {t('community.forum.newPost')}
            </Button>
          )}
        </div>
        {posts.isPending ? (
          <Skeleton className="h-24" />
        ) : list.length === 0 ? (
          <p role="status" className="py-10 text-center text-sm text-muted-foreground">
            {t('community.forum.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  data-testid="forum-post"
                  onClick={() => openThread({ channelId: channel.id, rootId: m.id })}
                  className="flex w-full flex-col gap-1.5 rounded-xl border bg-card px-4 py-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="font-semibold">{m.title ?? plainText(m.body, 80)}</span>
                  {!!m.tags?.length && (
                    <span className="flex flex-wrap gap-1">
                      {m.tags.map((x) => (
                        <span
                          key={x}
                          className="rounded-full border px-2 text-xs text-muted-foreground"
                        >
                          {x}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {plainText(m.body, 240)}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <UserAvatar userId={m.author.id} name={m.author.display_name} size="xs" />
                    <span>{m.author.display_name}</span>
                    <span className="ml-auto flex items-center gap-1">
                      <MessageSquareIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                      {t('threads.replies', { count: m.thread?.reply_count ?? 0 })}
                    </span>
                    <time dateTime={lastActivity(m)}>{date.format(new Date(lastActivity(m)))}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {posts.hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            disabled={posts.isFetchingNextPage}
            onClick={() => void posts.fetchNextPage()}
          >
            {t('home.more')}
          </Button>
        )}
      </div>
      <NewPostDialog channel={channel} open={writing} onOpenChange={setWriting} />
    </div>
  );
}

function NewPostDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const ids = { title: useId(), body: useId() };
  const queryClient = useQueryClient();
  const openThread = useLayout((s) => s.openThread);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const send = useMutation({
    mutationFn: () =>
      apiFetch<Message>(`/api/channels/${channel.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), tags, nonce: newNonce() }),
      }),
    onSuccess: (m) => {
      addMessage(queryClient, m);
      setTitle('');
      setBody('');
      setTags([]);
      onOpenChange(false);
      openThread({ channelId: channel.id, rootId: m.id });
    },
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('community.forum.failed')),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('community.forum.newPost')}</DialogTitle>
          <DialogDescription>
            {t('community.forum.newPostHint', { channel: channel.name })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && body.trim()) send.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={ids.title}>{t('community.forum.title')}</Label>
            <Input
              id={ids.title}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.body}>{t('community.forum.body')}</Label>
            <textarea
              id={ids.body}
              rows={6}
              value={body}
              maxLength={4000}
              onChange={(e) => setBody(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          {(channel.forum_tags ?? []).length > 0 && (
            <fieldset className="flex flex-wrap gap-1">
              <legend className="mb-1 text-sm font-medium">{t('community.forum.tags')}</legend>
              {channel.forum_tags!.map((x) => {
                const on = tags.includes(x);
                return (
                  <Button
                    key={x}
                    type="button"
                    size="sm"
                    variant={on ? 'secondary' : 'outline'}
                    aria-pressed={on}
                    className={cn(on && 'border-primary')}
                    disabled={!on && tags.length >= 5}
                    onClick={() => setTags(on ? tags.filter((y) => y !== x) : [...tags, x])}
                  >
                    {x}
                  </Button>
                );
              })}
            </fieldset>
          )}
          <DialogFooter>
            <Button type="submit" disabled={send.isPending || !title.trim() || !body.trim()}>
              {t('community.forum.publish')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
