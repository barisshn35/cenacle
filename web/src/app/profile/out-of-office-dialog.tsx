// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
import { clearOutOfOffice, myProfileQuery, saved, setOutOfOffice } from './profiles';

/** How long an automatic reply may be (the server's limit). */
const MAX_MESSAGE = 500;

/** "2026-11-12" of a date in the browser's time zone. */
const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Local midnight of a "2026-11-12" day. */
const startOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

/**
 * Out of office: the first day away and the day one is back. Meanwhile the
 * profile says so and a direct message gets one automatic reply.
 */
export function OutOfOfficeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const ids = { from: useId(), back: useId(), message: useId() };
  const me = useQuery(myProfileQuery);
  const current = me.data?.out_of_office ?? null;
  const today = dayOf(new Date());
  const [from, setFrom] = useState(current ? dayOf(new Date(current.from)) : today);
  const [back, setBack] = useState(current ? dayOf(new Date(current.until)) : '');
  const [message, setMessage] = useState(current?.message ?? '');
  const queryClient = useQueryClient();
  const valid = back !== '' && back > from && back > today;

  const save = useMutation({
    mutationFn: () =>
      setOutOfOffice({
        // From the first day's start (or now, when it is today); until the day back starts.
        from: (from <= today ? new Date() : startOf(from)).toISOString(),
        until: startOf(back).toISOString(),
        message: message.trim(),
      }),
    onSuccess: (profile) => {
      saved(queryClient, profile);
      toast.success(t('profile.away.saved'));
      onOpenChange(false);
    },
    onError: () => toast.error(t('profile.away.failed')),
  });
  const end = useMutation({
    mutationFn: clearOutOfOffice,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: myProfileQuery.queryKey });
      toast.success(t('profile.away.ended'));
      onOpenChange(false);
    },
    onError: () => toast.error(t('profile.away.failed')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('profile.away.title')}</DialogTitle>
          <DialogDescription>{t('profile.away.description')}</DialogDescription>
        </DialogHeader>
        <form id={ids.from + '-form'} className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.from}>{t('profile.away.from')}</Label>
              <Input
                id={ids.from}
                type="date"
                required
                value={from}
                min={today}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.back}>{t('profile.away.back')}</Label>
              <Input
                id={ids.back}
                type="date"
                required
                value={back}
                min={from >= today ? from : today}
                aria-invalid={(back !== '' && !valid) || undefined}
                aria-describedby={back !== '' && !valid ? `${ids.back}-error` : undefined}
                onChange={(e) => setBack(e.target.value)}
              />
            </div>
          </div>
          {back !== '' && !valid && (
            <p id={`${ids.back}-error`} className="-mt-2 text-xs text-destructive">
              {t('profile.away.backAfter')}
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor={ids.message}>{t('profile.away.message')}</Label>
            <textarea
              id={ids.message}
              value={message}
              maxLength={MAX_MESSAGE}
              rows={3}
              aria-describedby={`${ids.message}-hint`}
              onChange={(e) => setMessage(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <p id={`${ids.message}-hint`} className="text-xs text-muted-foreground">
              {t('profile.away.messageHint')}
            </p>
          </div>
        </form>
        <DialogFooter>
          {current && (
            <Button
              variant="outline"
              className="sm:me-auto"
              disabled={end.isPending}
              onClick={() => end.mutate()}
            >
              {t('profile.away.end')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('ui:confirm.cancel')}
          </Button>
          <Button type="submit" form={ids.from + '-form'} disabled={!valid || save.isPending}>
            {t('profile.away.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
