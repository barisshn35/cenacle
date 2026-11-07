// SPDX-License-Identifier: AGPL-3.0-only
import { SummarizeButton } from '../ai/ai-ui';
import { ChevronDownIcon, PanelRightIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { SidebarTrigger } from '@cenacle/ui/components/sidebar';
import { Logo } from '@cenacle/ui/brand';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';
import { ChannelIcon } from '../chat/channel-icon';
import { ArchivedNotice, ChannelSettingsDialog } from '../chat/channel-settings';
import { Composer } from '../chat/composer';
import { channelsQuery, isConversation } from '../chat/data';
import { NotMember } from '../chat/not-member';
import { usePermalink } from '../chat/permalink';
import { useActiveWorkspace } from '../chat/active-workspace';
import { isFuture } from '../community/community';
import { ForumView } from '../community/forum';
import { useQuickSwitcher } from '../chat/quick-switcher-state';
import { MessageList } from '../chat/message-list';
import { CanvasView } from '../collab/canvas-view';
import { ChannelTabs } from '../collab/channel-tabs';
import { tabsQuery } from '../collab/collab';
import { ListView } from '../collab/list-view';
import { GovernanceChip } from '../compliance/classification';
import { UnlockPanel } from '../compliance/encrypted';
import { useCanWrite } from '../compliance/e2e';
import { useMLSChannel } from '../e2e/use-mls-channel';
import { dateLocale } from '../../i18n/time-format';
import { usePageTitle } from './use-page-title';
import { CallAction, ChannelCallBar } from '../calls/channel-call';

/** Header buttons that open a panel: Brass while their panel is open. */
const HEADER_TOGGLE =
  'text-muted-foreground aria-pressed:bg-[color-mix(in_oklab,var(--accent-brand)_14%,transparent)] aria-pressed:text-accent-brand';

export function ChannelView({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const { id, channel } = useActiveChannel();
  const detailsOpen = useLayout((s) => s.detailsOpen);
  const rightView = useLayout((s) => s.rightView);
  const show = useLayout((s) => s.show);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const showing = (view: typeof rightView) => detailsOpen && rightView === view;
  const toggle = (view: typeof rightView) => (showing(view) ? setDetailsOpen(false) : show(view));
  const name = channel?.name ?? '';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const channelsLoaded = useQuery(channelsQuery).isSuccess;
  const { workspace } = useActiveWorkspace();
  usePageTitle(name, workspace?.name);
  usePermalink(channel ? id : undefined);
  const { tab: tabId } = useSearch({ strict: false }) as { tab?: string };
  const tabs = useQuery({ ...tabsQuery(id ?? ''), enabled: !!channel && !!tabId });
  const tab = tabId ? tabs.data?.find((x) => x.id === tabId) : undefined;
  const canWrite = useCanWrite(channel);
  useMLSChannel(channel);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex h-full min-w-0 flex-col bg-background outline-none"
      aria-labelledby="channel-title"
    >
      {/* The 56px band shared by the rail, the sidebar head and the panels. */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 max-sm:px-2">
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
            className="max-w-[60%] shrink-0 truncate text-[17px] leading-5 font-semibold tracking-[-0.01em]"
          >
            {channel && !isConversation(channel) ? (
              // The channel's name opens its settings: details, members and roles,
              // notifications (they were only in the details panel).
              <button
                type="button"
                className="flex max-w-full min-h-target items-center gap-1 rounded-md px-1 -mx-1 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-haspopup="dialog"
                title={t('channels.settingsWindow')}
                onClick={() => setSettingsOpen(true)}
              >
                <span className="truncate">{name}</span>
                <ChevronDownIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground"
                  strokeWidth={1.75}
                />
              </button>
            ) : (
              name
            )}
          </h1>
          {channel?.topic && (
            <p className="min-w-0 truncate text-[13.5px] text-muted-foreground max-sm:hidden">
              {channel.topic}
            </p>
          )}
        </div>
        {channel && (
          <div className="flex min-w-0 shrink max-md:hidden">
            <GovernanceChip channel={channel} onOpen={() => show('details')} />
          </div>
        )}
        {id && channel && !channel.encrypted && <SummarizeButton channelId={id} />}
        {channel && <CallAction channel={channel} />}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('search.open')}
          aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
          aria-pressed={showing('search')}
          className={HEADER_TOGGLE}
          onClick={() => toggle('search')}
        >
          <SearchIcon strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('shell.toggleDetails')}
          aria-pressed={showing('details')}
          className={HEADER_TOGGLE}
          onClick={() => toggle('details')}
        >
          <PanelRightIcon strokeWidth={1.75} />
        </Button>
      </header>
      {channel && settingsOpen && (
        <ChannelSettingsDialog
          channel={channel}
          open
          onOpenChange={(open) => !open && setSettingsOpen(false)}
        />
      )}
      {id && channel && <ChannelTabs channel={channel} active={tab?.id} />}
      {channel && <ChannelCallBar channel={channel} />}

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
                className="mx-auto max-w-3xl rounded-[10px] border border-dashed border-rule-strong px-4 py-3 text-sm text-muted-foreground"
              >
                {t('community.moderation.timedOutNotice', {
                  time: new Intl.DateTimeFormat(dateLocale(), {
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
                className="mx-auto max-w-3xl rounded-[10px] border border-dashed border-rule-strong px-4 py-3 text-sm text-muted-foreground"
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
