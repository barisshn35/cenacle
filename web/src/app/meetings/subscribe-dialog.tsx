// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
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
import { calendarFeedQuery, createCalendarFeed, deleteCalendarFeed } from './data';

/**
 * A private address that calendar programs read: the meetings show there too.
 * The address is shown once, when it is made; a new one replaces it.
 */
export function SubscribeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const feed = useQuery(calendarFeedQuery);
  const [url, setUrl] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: calendarFeedQuery.queryKey });
  const make = useMutation({
    mutationFn: createCalendarFeed,
    onSuccess: (r) => {
      setUrl(r.url);
      void refresh();
    },
    onError: () => toast.error(t('meetings.failed')),
  });
  const stop = useMutation({
    mutationFn: deleteCalendarFeed,
    onSuccess: () => {
      setUrl('');
      void refresh();
      toast.success(t('meetings.subscribe.stopped'));
    },
    onError: () => toast.error(t('meetings.failed')),
  });
  const copy = () => {
    navigator.clipboard.writeText(url).then(
      () => toast.success(t('meetings.subscribe.copied')),
      () => document.getElementById(id)?.focus(),
    );
  };
  const exists = !!feed.data?.exists;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('meetings.subscribe.title')}</DialogTitle>
          <DialogDescription>{t('meetings.subscribe.description')}</DialogDescription>
        </DialogHeader>
        {url ? (
          <div className="grid gap-1.5">
            <Label htmlFor={id}>{t('meetings.subscribe.address')}</Label>
            <div className="flex gap-2">
              <Input id={id} readOnly value={url} onFocus={(e) => e.target.select()} />
              <Button onClick={copy}>{t('meetings.subscribe.copy')}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('meetings.subscribe.once')}</p>
          </div>
        ) : (
          exists && (
            <p className="text-sm text-muted-foreground">{t('meetings.subscribe.exists')}</p>
          )
        )}
        <p className="text-xs text-muted-foreground">{t('meetings.subscribe.private')}</p>
        <DialogFooter className="gap-2">
          {exists && (
            <Button variant="outline" disabled={stop.isPending} onClick={() => stop.mutate()}>
              {t('meetings.subscribe.stop')}
            </Button>
          )}
          <Button disabled={make.isPending} onClick={() => make.mutate()}>
            {exists ? t('meetings.subscribe.replace') : t('meetings.subscribe.make')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
