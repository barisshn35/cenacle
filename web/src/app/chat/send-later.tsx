// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { cancelScheduled, scheduledQuery, scheduleMessage } from './commands';
import { channelsQuery, isConversation } from './data';

/** Today or later at a time of day (local). */
function at(days: number, hour: number, from = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** The next Monday (never today) at 9:00. */
function nextMonday(now = new Date()): Date {
  const days = (8 - now.getDay()) % 7 || 7;
  return at(days, 9, now);
}

/** The value of a datetime-local input for a date (local time, minutes). */
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function useFormatWhen() {
  const { i18n } = useTranslation();
  return (d: Date | string) =>
    new Intl.DateTimeFormat(i18n.language, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(d));
}

/** What is scheduled, with a way to cancel each. */
function ScheduledList() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const formatWhen = useFormatWhen();
  const list = useQuery(scheduledQuery);
  const channels = useQuery(channelsQuery);
  const name = (id: string, fallback: string) => {
    const c = channels.data?.find((x) => x.id === id);
    if (!c) return fallback;
    return isConversation(c) ? c.name : `#${c.name}`;
  };
  const cancel = useMutation({
    mutationFn: cancelScheduled,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduled'] }),
    onError: () => toast.error(t('scheduled.cancelFailed')),
  });
  const items = list.data ?? [];
  return (
    <section aria-labelledby="scheduled-title" className="flex flex-col gap-2">
      <h3 id="scheduled-title" className="text-sm font-semibold">
        {t('scheduled.listTitle', { count: items.length })}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('scheduled.none')}</p>
      ) : (
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border">
          {items.map((s) => (
            <li
              key={s.id}
              data-testid="scheduled"
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate">{s.body}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {s.kind === 'reminder'
                    ? t('scheduled.reminder')
                    : name(s.channel_id, s.channel_name)}
                  {' · '}
                  {formatWhen(s.send_at)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                aria-label={t('scheduled.cancelNamed', { when: formatWhen(s.send_at) })}
                onClick={() => cancel.mutate(s.id)}
              >
                {t('scheduled.cancel')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Schedules the composer's text: a few common times or any other one. Also
 * lists everything scheduled (messages and reminders).
 */
export function SendLaterDialog({
  open,
  onOpenChange,
  channelId,
  body,
  onScheduled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  /** The text to send (mentions resolved); empty only lists. */
  body: () => string;
  onScheduled: () => void;
}) {
  const { t } = useTranslation();
  const hasBody = open && body().trim() !== '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('scheduled.title')}</DialogTitle>
          <DialogDescription>
            {hasBody ? t('scheduled.description') : t('scheduled.emptyDescription')}
          </DialogDescription>
        </DialogHeader>
        {hasBody && (
          <SchedulePicker
            channelId={channelId}
            body={body}
            onScheduled={() => {
              onScheduled();
              onOpenChange(false);
            }}
          />
        )}
        <ScheduledList />
      </DialogContent>
    </Dialog>
  );
}

/** Common times and any other one; mounted when the dialog opens, so "now" is current. */
function SchedulePicker({
  channelId,
  body,
  onScheduled,
}: {
  channelId: string;
  body: () => string;
  onScheduled: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const formatWhen = useFormatWhen();
  const [now] = useState(() => new Date());
  const [custom, setCustom] = useState(() => localInput(at(1, 9, now)));
  const schedule = useMutation({
    mutationFn: (when: Date) => scheduleMessage(channelId, body(), when),
    onSuccess: async (s) => {
      toast(t('scheduled.done', { when: formatWhen(s.send_at) }));
      onScheduled();
      await queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });
  const presets = [
    { label: t('scheduled.inHour'), when: new Date(now.getTime() + 60 * 60_000) },
    { label: t('scheduled.tomorrow'), when: at(1, 9, now) },
    { label: t('scheduled.monday'), when: nextMonday(now) },
  ];
  const customDate = custom ? new Date(custom) : undefined;
  const customValid =
    !!customDate &&
    !Number.isNaN(customDate.getTime()) &&
    customDate.getTime() > now.getTime() + 60_000;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {presets.map((p) => (
          <Button
            key={p.label}
            variant="outline"
            className="justify-between"
            disabled={schedule.isPending}
            onClick={() => schedule.mutate(p.when)}
          >
            <span>{p.label}</span>
            <span className="text-xs text-muted-foreground">{formatWhen(p.when)}</span>
          </Button>
        ))}
      </div>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (customValid) schedule.mutate(customDate);
        }}
      >
        <Label htmlFor={`${id}-when`}>{t('scheduled.custom')}</Label>
        <div className="flex gap-2">
          <Input
            id={`${id}-when`}
            type="datetime-local"
            value={custom}
            min={localInput(now)}
            onChange={(e) => setCustom(e.target.value)}
            aria-invalid={(!!custom && !customValid) || undefined}
          />
          <Button type="submit" disabled={!customValid || schedule.isPending}>
            {t('scheduled.schedule')}
          </Button>
        </div>
      </form>
      {schedule.isError && (
        <InlineError
          problem={schedule.error instanceof ApiError ? schedule.error.problem : { status: 500 }}
        />
      )}
    </div>
  );
}
