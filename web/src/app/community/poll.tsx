// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BarChart3Icon, CheckIcon, LockIcon, PlusIcon, Trash2Icon } from 'lucide-react';
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
import { useSession } from '../auth/session';
import { addMessage, patchMessage, type Channel, type Message } from '../chat/data';
import { newNonce } from '../chat/pending';
import { closePoll, sendPoll, votePoll, type Poll } from './community';

/** A message's poll: choose, see the results, close it (author, managers). */
export function PollCard({ message, channel }: { message: Message; channel: Channel }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const poll = message.poll!;
  const name = useId();
  const total = poll.options.reduce((n, o) => n + o.votes, 0);
  const voted = poll.options.some((o) => o.me);
  const canVote = !poll.closed && !channel.archived && channel.is_member;
  const setPoll = (p: Poll) =>
    patchMessage(queryClient, message.channel_id, message.id, (m) => ({ ...m, poll: p }));
  const vote = useMutation({
    mutationFn: (ids: string[]) => votePoll(message.channel_id, message.id, ids),
    onSuccess: setPoll,
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.problem.code === 'poll_closed'
          ? t('community.poll.closedNow')
          : (err instanceof ApiError && err.problem.detail) || t('community.poll.failed'),
      ),
  });
  const close = useMutation({
    mutationFn: () => closePoll(message.channel_id, message.id),
    onSuccess: setPoll,
    onError: () => toast.error(t('community.poll.failed')),
  });
  const choose = (id: string) => {
    const mine = poll.options.filter((o) => o.me).map((o) => o.id);
    if (!poll.multiple) return vote.mutate(mine.includes(id) ? [] : [id]);
    vote.mutate(mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id]);
  };
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <fieldset
      data-testid="poll"
      className="mt-1.5 flex max-w-md flex-col gap-1.5 rounded-[10px] border border-rule-strong bg-background p-3"
    >
      <legend className="sr-only">{t('community.poll.legend')}</legend>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BarChart3Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
        {poll.multiple ? t('community.poll.multiple') : t('community.poll.single')}
        {poll.anonymous && ` · ${t('community.poll.anonymous')}`}
      </p>
      {poll.options.map((o) => {
        const share = total ? Math.round((o.votes / total) * 100) : 0;
        const voters = o.voters?.map((v) => v.display_name).join(', ');
        return (
          <button
            key={o.id}
            type="button"
            role={poll.multiple ? 'checkbox' : 'radio'}
            name={name}
            aria-checked={o.me}
            disabled={!canVote || vote.isPending}
            title={voters || undefined}
            onClick={() => choose(o.id)}
            className={cn(
              'relative flex min-h-target items-center gap-2 overflow-hidden rounded-lg border px-3 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default',
              o.me ? 'border-primary' : 'hover:bg-accent/50',
            )}
          >
            {(voted || poll.closed) && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-primary/10 motion-safe:transition-[width]"
                style={{ width: `${share}%` }}
              />
            )}
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              {o.me && <CheckIcon aria-hidden className="size-4 text-primary" strokeWidth={2} />}
            </span>
            <span className="relative min-w-0 flex-1">{o.text}</span>
            {(voted || poll.closed) && (
              <span className="relative text-xs text-muted-foreground tabular-nums">
                {t('community.poll.votes', { count: o.votes })} · {share}%
              </span>
            )}
          </button>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t('community.poll.voters', { count: poll.voters })}</span>
        {poll.closed ? (
          <span className="flex items-center gap-1">
            <LockIcon aria-hidden className="size-3" strokeWidth={1.75} />
            {t('community.poll.closed')}
          </span>
        ) : (
          poll.closes_at && (
            <span>
              {t('community.poll.closesAt', { time: date.format(new Date(poll.closes_at)) })}
            </span>
          )
        )}
        {!poll.closed && (message.author.id === user.id || channel.can_manage) && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={close.isPending}
            onClick={() => close.mutate()}
          >
            {t('community.poll.close')}
          </Button>
        )}
      </div>
    </fieldset>
  );
}

const CLOSES = ['', '1h', '1d', '1w'] as const;

function closesAt(choice: (typeof CLOSES)[number]): string | undefined {
  const hours = { '': 0, '1h': 1, '1d': 24, '1w': 168 }[choice];
  return hours ? new Date(Date.now() + hours * 3600_000).toISOString() : undefined;
}

/** Writing a poll: a question, 2 to 10 options and how people answer. */
export function PollDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const ids = { q: useId(), closes: useId() };
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closes, setCloses] = useState<(typeof CLOSES)[number]>('');
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const send = useMutation({
    mutationFn: () =>
      sendPoll(
        channelId,
        question.trim(),
        { options: filled, multiple, anonymous, closes_at: closesAt(closes) },
        newNonce(),
      ),
    onSuccess: (m) => {
      addMessage(queryClient, m);
      setQuestion('');
      setOptions(['', '']);
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('community.poll.failed')),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('community.poll.create')}</DialogTitle>
          <DialogDescription>{t('community.poll.createHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim() && filled.length >= 2) send.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={ids.q}>{t('community.poll.question')}</Label>
            <Input
              id={ids.q}
              value={question}
              maxLength={4000}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">{t('community.poll.options')}</legend>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-1">
                <Input
                  aria-label={t('community.poll.option', { n: i + 1 })}
                  value={o}
                  maxLength={200}
                  onChange={(e) =>
                    setOptions(options.map((x, j) => (j === i ? e.target.value : x)))
                  }
                />
                {options.length > 2 && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('community.poll.removeOption', { n: i + 1 })}
                    onClick={() => setOptions(options.filter((_, j) => j !== i))}
                  >
                    <Trash2Icon strokeWidth={1.75} />
                  </Button>
                )}
              </div>
            ))}
            {options.length < 10 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => setOptions([...options, ''])}
              >
                <PlusIcon strokeWidth={1.75} />
                {t('community.poll.addOption')}
              </Button>
            )}
          </fieldset>
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-target-exempt
              className="size-4 accent-primary"
              checked={multiple}
              onChange={(e) => setMultiple(e.target.checked)}
            />
            {t('community.poll.allowMultiple')}
          </label>
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-target-exempt
              className="size-4 accent-primary"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            {t('community.poll.makeAnonymous')}
          </label>
          <div className="grid gap-1">
            <Label htmlFor={ids.closes}>{t('community.poll.closes')}</Label>
            <select
              id={ids.closes}
              value={closes}
              onChange={(e) => setCloses(e.target.value as typeof closes)}
              className="min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {CLOSES.map((c) => (
                <option key={c} value={c}>
                  {t(`community.poll.closesIn.${c || 'never'}`)}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={send.isPending || !question.trim() || filled.length < 2}
            >
              {t('community.poll.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
