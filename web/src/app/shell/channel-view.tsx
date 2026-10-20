// SPDX-License-Identifier: Apache-2.0
import { HashIcon, LockIcon, MegaphoneIcon, PanelRightIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { ScrollArea } from '@cenacle/ui/components/scroll-area';
import { Separator } from '@cenacle/ui/components/separator';
import { SidebarTrigger } from '@cenacle/ui/components/sidebar';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { findChannel, directMessages } from '../../lib/sample-data';
import { useLayout } from '../../stores/layout';
import { AppearanceControls } from './appearance-controls';

const icons = { public: HashIcon, private: LockIcon, announcement: MegaphoneIcon };

function useActiveConversation() {
  const id = useLayout((s) => s.activeChannelId);
  const channel = findChannel(id);
  if (channel) return { name: channel.name, topic: channel.topic, Icon: icons[channel.kind] };
  const dm = directMessages.find((d) => d.id === id);
  return { name: dm?.name ?? '', topic: '', Icon: undefined };
}

export function ChannelView({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const { name, topic, Icon } = useActiveConversation();
  const detailsOpen = useLayout((s) => s.detailsOpen);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);

  return (
    <main className="flex h-full min-w-0 flex-col bg-background" aria-labelledby="channel-title">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        {mobile && <SidebarTrigger />}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {Icon && (
            <Icon
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
            />
          )}
          <h1 id="channel-title" className="truncate text-[15px] font-semibold">
            {name}
          </h1>
          {topic && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4 self-center! max-sm:hidden" />
              <p className="truncate text-sm text-muted-foreground max-sm:hidden">{topic}</p>
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

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          <div className="flex flex-col gap-1">
            <p className="text-xl font-semibold">{t('shell.channelStart', { channel: name })}</p>
            <p className="text-sm text-muted-foreground">{t('shell.messagesPlaceholder')}</p>
          </div>
          {/* Layout placeholders keep the final message geometry (no layout shift later). */}
          <div aria-hidden className="flex flex-col gap-5">
            {[72, 48, 88, 60, 36].map((w, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="flex flex-1 flex-col gap-2 pt-0.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>

      <footer className="shrink-0 px-4 pb-4">
        <div className="mx-auto max-w-3xl">
          <label htmlFor="composer" className="sr-only">
            {t('shell.composerPlaceholder', { channel: name })}
          </label>
          <textarea
            id="composer"
            rows={1}
            disabled
            aria-describedby="composer-hint"
            placeholder={t('shell.composerPlaceholder', { channel: name })}
            className="min-h-target w-full resize-none rounded-xl border border-input bg-card px-4 py-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <p id="composer-hint" className="mt-1.5 px-1 text-xs text-muted-foreground">
            {t('shell.composerDisabled')}
          </p>
        </div>
      </footer>
    </main>
  );
}
