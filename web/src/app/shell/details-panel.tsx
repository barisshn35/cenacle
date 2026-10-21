// SPDX-License-Identifier: Apache-2.0
import { LogOutIcon, XIcon } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { joinChannel, leaveChannel, reloadChannels, type Channel } from '../chat/data';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';

export function DetailsPanel() {
  const { t } = useTranslation();
  const { channel } = useActiveChannel();
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);

  return (
    <aside aria-labelledby="details-title" className="flex h-full flex-col border-l bg-background">
      <header className="flex min-h-12 items-center justify-between border-b px-3">
        <h2 id="details-title" className="text-sm font-semibold">
          {t('shell.details')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('shell.closeDetails')}
          onClick={() => setDetailsOpen(false)}
        >
          <XIcon strokeWidth={1.75} />
        </Button>
      </header>
      {channel && (
        <dl className="flex flex-col gap-4 p-4 text-sm">
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-muted-foreground uppercase">
              {t('shell.about')}
            </dt>
            <dd>{channel.topic || t('shell.noTopic')}</dd>
          </div>
          <div className="flex flex-col gap-2">
            <dt className="sr-only">{t('channels.membership')}</dt>
            <dd>
              {channel.is_mandatory ? (
                <p className="text-muted-foreground">{t('channels.mandatory')}</p>
              ) : (
                <LeaveButton channel={channel} />
              )}
            </dd>
          </div>
        </dl>
      )}
    </aside>
  );
}

/** Leaving is easy to undo, so it asks nothing and offers "Undo" (UX plan). */
function LeaveButton({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const leave = useMutation({
    mutationFn: () => leaveChannel(channel.id),
    onSuccess: async () => {
      await reloadChannels(queryClient);
      void navigate({ to: '/' });
      showUndoToast({
        message: t('channels.left', { channel: channel.name }),
        onUndo: async () => {
          await joinChannel(channel.id);
          await reloadChannels(queryClient);
          void navigate({ to: '/c/$channelId', params: { channelId: channel.id } });
        },
      });
    },
    onError: () => toast.error(t('channels.leaveFailed')),
  });
  return (
    <Button variant="outline" size="sm" disabled={leave.isPending} onClick={() => leave.mutate()}>
      <LogOutIcon aria-hidden strokeWidth={1.75} />
      {t('channels.leave')}
    </Button>
  );
}
