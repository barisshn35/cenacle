// SPDX-License-Identifier: Apache-2.0
import { PanelRightIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { Separator } from '@cenacle/ui/components/separator';
import { SidebarTrigger } from '@cenacle/ui/components/sidebar';
import { Logo } from '@cenacle/ui/brand';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';
import { ChannelIcon } from '../chat/channel-icon';
import { Composer } from '../chat/composer';
import { channelsQuery } from '../chat/data';
import { NotMember } from '../chat/not-member';
import { MessageList } from '../chat/message-list';
import { AppearanceControls } from './appearance-controls';

export function ChannelView({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const { id, channel } = useActiveChannel();
  const detailsOpen = useLayout((s) => s.detailsOpen);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const name = channel?.name ?? '';
  const channelsLoaded = useQuery(channelsQuery).isSuccess;

  return (
    <main className="flex h-full min-w-0 flex-col bg-background" aria-labelledby="channel-title">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        {mobile && (
          <>
            <SidebarTrigger />
            <Logo variant="icon" size={24} />
          </>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {channel && (
            <ChannelIcon
              channel={channel}
              labelled
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
          <h1
            id="channel-title"
            className="max-w-[60%] shrink-0 truncate text-[15px] font-semibold"
          >
            {name}
          </h1>
          {channel?.topic && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4 self-center! max-sm:hidden" />
              <p className="min-w-0 truncate text-sm text-muted-foreground max-sm:hidden">
                {channel.topic}
              </p>
            </>
          )}
        </div>
        {!mobile && <AppearanceControls />}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('shell.toggleDetails')}
          aria-pressed={detailsOpen}
          onClick={() => setDetailsOpen(!detailsOpen)}
        >
          <PanelRightIcon strokeWidth={1.75} />
        </Button>
      </header>

      {id && channel ? (
        <>
          <MessageList key={`log-${id}`} channelId={id} channelName={name} />
          {channel.can_post ? (
            <Composer key={`composer-${id}`} channelId={id} channelName={name} />
          ) : (
            <footer className="shrink-0 px-4 pb-4">
              <p
                data-testid="read-only-notice"
                className="mx-auto max-w-3xl rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground"
              >
                {t('channels.readOnly', { channel: name })}
              </p>
            </footer>
          )}
        </>
      ) : id && channelsLoaded ? (
        <NotMember channelId={id} />
      ) : (
        <div className="flex-1" />
      )}
    </main>
  );
}
