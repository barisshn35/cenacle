// SPDX-License-Identifier: AGPL-3.0-only
import { ChannelShares } from '../federation/channel-shares';
import { ChannelNotificationsSection } from '../notifications/channel-notifications';
import { PinsSection } from '../threads/pins-section';
import { RunsSection } from '../community/playbooks';
import { LogOutIcon, XIcon } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { ChannelFiles } from '../chat/channel-files';
import { MembersSection, VisibilitySetting } from '../chat/channel-members';
import {
  isConversation,
  joinChannel,
  leaveChannel,
  reloadChannels,
  type Channel,
} from '../chat/data';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';
import { EncryptionInfo } from '../compliance/encrypted';
import { EnableEncryption, MLSInfo } from '../e2e/ui';
import { TitleBlock } from './title-block';

export function DetailsPanel() {
  const { t } = useTranslation();
  const { channel } = useActiveChannel();
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);

  return (
    <aside
      aria-labelledby="details-title"
      className="flex h-full flex-col overflow-y-auto border-s bg-secondary"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-5">
        <h2 id="details-title" className="text-[15px] font-semibold">
          {t('shell.toggleDetails')}
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
      {channel && !isConversation(channel) && (
        <div className="px-5 pt-4">
          <TitleBlock channel={channel} />
        </div>
      )}
      {channel?.mls ? (
        <MLSInfo channel={channel} />
      ) : (
        channel?.encrypted && <EncryptionInfo channel={channel} />
      )}
      {channel && !channel.encrypted && <EnableEncryption channel={channel} />}
      {channel && <ChannelShares channel={channel} />}
      {channel && isConversation(channel) && (
        <div className="flex flex-col gap-3 p-4 text-sm">
          <p className="text-muted-foreground">{t(`dm.about.${channel.kind}`)}</p>
          {channel.kind === 'group' && (
            <div>
              <LeaveButton channel={channel} />
            </div>
          )}
        </div>
      )}
      {channel && !isConversation(channel) && (
        <dl className="flex flex-col gap-4 px-5 py-4 text-sm">
          <div className="flex flex-col gap-1">
            <dt className="text-[13px] font-semibold">{t('shell.about')}</dt>
            <dd>{channel.topic || t('shell.noTopic')}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-[13px] font-semibold">{t('channels.visibility.label')}</dt>
            <dd>
              <VisibilitySetting channel={channel} />
            </dd>
          </div>
          <div className="flex flex-col gap-2">
            <dt className="sr-only">{t('channels.membership')}</dt>
            <dd>
              {channel.is_mandatory ? (
                <p className="text-muted-foreground">{t('channels.mandatory')}</p>
              ) : channel.group_managed ? (
                <p className="text-muted-foreground">{t('channels.groupManaged')}</p>
              ) : (
                <LeaveButton channel={channel} />
              )}
            </dd>
          </div>
        </dl>
      )}
      {channel && (
        <div className="border-t px-5 py-4">
          <PinsSection channelId={channel.id} />
        </div>
      )}
      {channel && !isConversation(channel) && (
        <div className="border-t px-5 py-4 empty:hidden">
          <RunsSection channelId={channel.id} canPost={channel.can_post} />
        </div>
      )}
      {channel && (
        <div className="border-t px-5 py-4">
          <ChannelNotificationsSection channel={channel} />
        </div>
      )}
      {channel && (
        <div className="border-t px-5 py-4">
          <MembersSection channel={channel} />
        </div>
      )}
      {channel && (
        <div className="border-t px-5 py-4">
          <ChannelFiles channelId={channel.id} />
        </div>
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
