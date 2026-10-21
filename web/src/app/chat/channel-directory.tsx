// SPDX-License-Identifier: Apache-2.0
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ChannelIcon } from './channel-icon';
import { directoryQuery, joinChannel, reloadChannels, type Channel } from './data';

/** Every channel, to open or join. */
export function ChannelDirectory({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const directory = useQuery({ ...directoryQuery, enabled: open });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const go = (c: Channel) => {
    onOpenChange(false);
    void navigate({ to: '/c/$channelId', params: { channelId: c.id } });
  };
  const join = useMutation({
    mutationFn: (c: Channel) => joinChannel(c.id),
    onSuccess: (c) => {
      void reloadChannels(queryClient);
      go(c);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('channels.browseTitle')}</DialogTitle>
          <DialogDescription>{t('channels.browseDescription')}</DialogDescription>
        </DialogHeader>
        {directory.isPending ? (
          <div aria-hidden className="grid gap-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : directory.isError ? (
          <ErrorState
            problem={
              directory.error instanceof ApiError ? directory.error.problem : { status: 500 }
            }
          />
        ) : (
          <ul className="-mx-2 grid max-h-[60svh] gap-1 overflow-y-auto">
            {directory.data.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                <ChannelIcon
                  channel={c}
                  labelled
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{c.name}</p>
                  {c.topic && <p className="truncate text-xs text-muted-foreground">{c.topic}</p>}
                </div>
                {c.is_member ? (
                  <Button size="sm" variant="ghost" onClick={() => go(c)}>
                    {t('channels.open')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={join.isPending}
                    onClick={() => join.mutate(c)}
                    aria-label={t('channels.joinNamed', { channel: c.name })}
                  >
                    {t('channels.join')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
