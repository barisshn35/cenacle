// SPDX-License-Identifier: AGPL-3.0-only
import { SummarizeButton } from '../ai/ai-ui';
import { PanelRightIcon, SearchIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { Separator } from '@cenacle/ui/components/separator';
import { SidebarTrigger } from '@cenacle/ui/components/sidebar';
import { Logo } from '@cenacle/ui/brand';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';
import { ChannelIcon } from '../chat/channel-icon';
import { ArchivedNotice } from '../chat/channel-settings';
import { Composer } from '../chat/composer';
import { channelsQuery } from '../chat/data';
import { NotMember } from '../chat/not-member';
import { usePermalink } from '../chat/permalink';
import { useActiveWorkspace } from '../chat/active-workspace';
import { isFuture } from '../community/community';
import { ForumView } from '../community/forum';
import { useQuickSwitcher } from '../chat/quick-switcher-state';
import { MessageList } from '../chat/message-list';
import { useSaveAppearance } from '../appearance/use-save-appearance';
import { AppearanceControls } from './appearance-controls';
import { CanvasView } from '../collab/canvas-view';
import { ChannelTabs } from '../collab/channel-tabs';
import { tabsQuery } from '../collab/collab';
import { ListView } from '../collab/list-view';
import { ClassificationBanner } from '../compliance/classification';
import { UnlockPanel } from '../compliance/encrypted';
import { useCanWrite } from '../compliance/e2e';

export function ChannelView({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const saveAppearance = useSaveAppearance();
  const { id, channel } = useActiveChannel();
  const detailsOpen = useLayout((s) => s.detailsOpen);
  const rightView = useLayout((s) => s.rightView);
  const show = useLayout((s) => s.show);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const showing = (view: typeof rightView) => detailsOpen && rightView === view;
  const toggle = (view: typeof rightView) => (showing(view) ? setDetailsOpen(false) : show(view));
  const name = channel?.name ?? '';
  const channelsLoaded = useQuery(channelsQuery).isSuccess;
  const { workspace } = useActiveWorkspace();
  usePermalink(channel ? id : undefined);
  const { tab: tabId } = useSearch({ strict: false }) as { tab?: string };
  const tabs = useQuery({ ...tabsQuery(id ?? ''), enabled: !!channel && !!tabId });
  const tab = tabId ? tabs.data?.find((x) => x.id === tabId) : undefined;
  const canWrite = useCanWrite(channel);

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
            className="max-w-[60%] shrink-0 truncate text-[0.9375rem] font-semibold"
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
        {!mobile && <AppearanceControls onSave={(change) => saveAppearance.mutate(change)} />}
        {id && channel && !channel.encrypted && <SummarizeButton channelId={id} />}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('search.open')}
          aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
          aria-pressed={showing('search')}
          onClick={() => toggle('search')}
        >
          <SearchIcon strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('shell.toggleDetails')}
          aria-pressed={showing('details')}
          onClick={() => toggle('details')}
        >
          <PanelRightIcon strokeWidth={1.75} />
        </Button>
      </header>
      {id && channel && <ChannelTabs channel={channel} active={tab?.id} />}
      {channel && <ClassificationBanner channel={channel} />}

      {tab?.canvas_id ? (
        <CanvasView key={tab.canvas_id} canvasId={tab.canvas_id} />
      ) : tab?.list_id ? (
        <ListView key={tab.list_id} listId={tab.list_id} />
      ) : id && channel?.kind === 'forum' ? (
        <ForumView key={`forum-${id}`} channel={channel} />
      ) : id && channel ? (
        <>
          <MessageList key={`log-${id}`} channel={channel} />
          {channel.archived ? (
            <ArchivedNotice channel={channel} />
          ) : channel.can_post && isFuture(workspace?.timeout_until) ? (
            <footer className="shrink-0 px-4 pb-4">
              <p
                role="status"
                data-testid="timed-out-notice"
                className="mx-auto max-w-3xl rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground"
              >
                {t('community.moderation.timedOutNotice', {
                  time: new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(workspace!.timeout_until!)),
                })}
              </p>
            </footer>
          ) : channel.can_post && channel.encrypted && !canWrite ? (
            <UnlockPanel channel={channel} />
          ) : channel.can_post ? (
            <Composer
              key={`composer-${id}`}
              channelId={id}
              channelName={name}
              slowMode={channel.can_manage ? 0 : (channel.slow_mode_seconds ?? 0)}
            />
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
      ) : id ? (
        <div className="flex-1" />
      ) : (
        <NoChannel />
      )}
    </main>
  );
}

/** A workspace without channels to open (new, or all left). */
function NoChannel() {
  const { t } = useTranslation();
  const openSwitcher = useQuickSwitcher((s) => s.setOpen);
  return (
    <div
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="font-display text-2xl font-medium">{t('chat.noChannels')}</p>
      <p className="text-muted-foreground">{t('chat.noChannelsHint')}</p>
      <Button variant="outline" onClick={() => openSwitcher(true)}>
        {t('shell.jumpTo')}
      </Button>
    </div>
  );
}
