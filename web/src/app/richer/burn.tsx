// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, FlameIcon, TimerIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { useSession } from '../auth/session';
import type { Message } from '../chat/data';
import { MessageBody } from '../chat/markdown/message-body';
import { applyBurned, applyRevealed, BURN_TIMES, revealMessage } from './richer';
import { useBurnLabel } from './use-burn-label';

/** Seconds left of a revealed message (null: not revealed). */
function useSecondsLeft(m: Message): number | null {
  const until = m.burn?.revealed_at
    ? new Date(m.burn.revealed_at).getTime() + m.burn.seconds * 1000
    : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? null : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * The text of a burn-on-read message. Its recipients see it only after
 * choosing to, for a set time; then it is gone (also from the server once
 * everyone has read it). Its author always sees it.
 */
export function BurnBody({ message }: { message: Message }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const label = useBurnLabel();
  const left = useSecondsLeft(message);
  const burn = message.burn!;
  const own = message.author.id === self;
  const expired = !own && left === 0;

  useEffect(() => {
    if (expired && message.body) applyBurned(queryClient, message);
  }, [expired, message, queryClient]);

  const reveal = useMutation({
    mutationFn: () => revealMessage(message),
    onSuccess: (m) => applyRevealed(queryClient, m),
    onError: (err) => {
      if (err instanceof ApiError && err.problem.code === 'burned') {
        applyBurned(queryClient, message);
        return;
      }
      toast.error(t('richer.burn.failed'));
    },
  });

  const note = (
    <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="burn-note">
      <FlameIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {own
        ? t('richer.burn.sent', { time: label(burn.seconds) })
        : left !== null && left > 0
          ? t('richer.burn.left', { time: label(left) })
          : t('richer.burn.label', { time: label(burn.seconds) })}
    </p>
  );

  if (burn.hidden || !message.body) {
    const gone = !own && (expired || (burn.revealed_at && burn.hidden));
    return (
      <div className="flex flex-col items-start gap-1 py-0.5" data-testid="burn">
        {gone ? (
          <p className="text-sm text-muted-foreground italic">{t('richer.burn.gone')}</p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={reveal.isPending}
            onClick={() => reveal.mutate()}
          >
            <EyeIcon strokeWidth={1.75} />
            {own ? t('richer.burn.showOwn') : t('richer.burn.reveal')}
          </Button>
        )}
        {!gone && note}
      </div>
    );
  }
  return (
    <div data-testid="burn">
      <MessageBody body={message.body} mentions={message.mentions} selfId={self} />
      {note}
    </div>
  );
}

/** The composer's burn-on-read choice (direct and group conversations). */
export function BurnChoice({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (seconds: number | null) => void;
}) {
  const { t } = useTranslation();
  const label = useBurnLabel();
  return (
    <label className="flex min-h-target items-center gap-2 text-sm" data-target>
      <TimerIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.75} />
      <span>{t('richer.burn.choice')}</span>
      <select
        data-testid="burn-choice"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">{t('richer.burn.off')}</option>
        {BURN_TIMES.map((s) => (
          <option key={s} value={s}>
            {label(s)}
          </option>
        ))}
      </select>
    </label>
  );
}
