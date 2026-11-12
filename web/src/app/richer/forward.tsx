// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ForwardIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
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
import { cn } from '@cenacle/ui/lib/utils';
import { ChannelIcon } from '../chat/channel-icon';
import { channelsQuery, type Message } from '../chat/data';
import { MessageBody } from '../chat/markdown/message-body';
import { useSession } from '../auth/session';
import { forwardMessage } from './richer';
import { dateLocale } from '../../i18n/time-format';

/** A forwarded message: what was said, by whom and where. */
export function ForwardedQuote({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const self = useSession().user.id;
  const f = message.forward;
  if (!f) return null;
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <figure
      data-testid="forwarded"
      className="mt-1 max-w-xl rounded-lg border border-s-3 border-s-muted-foreground/40 bg-muted/30 px-3 py-2"
    >
      <figcaption className="mb-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <ForwardIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
        {t('richer.forward.from', {
          name: f.author.display_name,
          channel: f.channel_name,
          when: when.format(new Date(f.created_at)),
        })}
      </figcaption>
      <MessageBody body={f.body} mentions={[]} selfId={self} />
    </figure>
  );
}

/**
 * Sends copies of messages, in the order they were written, to another
 * channel; the optional comment goes with the first.
 */
export function ForwardDialog({
  messages,
  open,
  onOpenChange,
  onSent,
}: {
  messages: Message[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
}) {
  const { t } = useTranslation();
  const ids = { filter: useId(), comment: useId() };
  const navigate = useNavigate();
  const channels = (useQuery(channelsQuery).data ?? []).filter((c) => c.can_post && !c.archived);
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const shown = channels.filter((c) =>
    c.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  const send = useMutation({
    mutationFn: async () => {
      const ordered = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
      let sent: Message | undefined;
      for (const [i, m] of ordered.entries()) {
        sent = await forwardMessage(m, target!, i === 0 ? comment.trim() : '');
      }
      return sent!;
    },
    onSuccess: (sent) => {
      onOpenChange(false);
      onSent?.();
      toast.success(t('richer.forward.done', { count: messages.length }), {
        action: {
          label: t('richer.forward.open'),
          onClick: () =>
            void navigate({ to: '/c/$channelId', params: { channelId: sent.channel_id } }),
        },
      });
    },
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('richer.forward.failed')),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('richer.forward.title', { count: messages.length })}</DialogTitle>
          <DialogDescription>{t('richer.forward.hint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (target) send.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={ids.filter}>{t('richer.forward.to')}</Label>
            <Input
              id={ids.filter}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('richer.forward.search')}
            />
          </div>
          <ul
            role="listbox"
            aria-label={t('richer.forward.to')}
            className="max-h-56 overflow-y-auto rounded-lg border p-1"
          >
            {shown.length === 0 && (
              <li className="px-2 py-3 text-center text-sm text-muted-foreground">
                {t('richer.forward.none')}
              </li>
            )}
            {shown.map((c) => (
              <li
                key={c.id}
                role="option"
                aria-selected={target === c.id}
                tabIndex={0}
                data-target
                onClick={() => setTarget(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setTarget(c.id);
                  }
                }}
                className={cn(
                  'flex min-h-target cursor-pointer items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  target === c.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
              >
                <ChannelIcon channel={c} className="size-4 text-muted-foreground" />
                <span className="truncate">{c.name}</span>
              </li>
            ))}
          </ul>
          <div className="grid gap-1">
            <Label htmlFor={ids.comment}>{t('richer.forward.comment')}</Label>
            <Input
              id={ids.comment}
              value={comment}
              maxLength={4000}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!target || send.isPending}>
              <ForwardIcon strokeWidth={1.75} />
              {t('richer.forward.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
