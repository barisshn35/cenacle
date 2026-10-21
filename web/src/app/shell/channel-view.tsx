// SPDX-License-Identifier: Apache-2.0
import { HashIcon, PanelRightIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { Separator } from '@cenacle/ui/components/separator';
import { SidebarTrigger } from '@cenacle/ui/components/sidebar';
import { Logo } from '@cenacle/ui/brand';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';
import { Composer } from '../chat/composer';
import { MessageList } from '../chat/message-list';
import { AppearanceControls } from './appearance-controls';

export function ChannelView({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const { id, channel } = useActiveChannel();
  const detailsOpen = useLayout((s) => s.detailsOpen);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const name = channel?.name ?? '';

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
          <HashIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <h1 id="channel-title" className="truncate text-[15px] font-semibold">
            {name}
          </h1>
          {channel?.topic && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4 self-center! max-sm:hidden" />
              <p className="truncate text-sm text-muted-foreground max-sm:hidden">
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
          <Composer key={`composer-${id}`} channelId={id} channelName={name} />
        </>
      ) : (
        <div className="flex-1" />
      )}
    </main>
  );
}
