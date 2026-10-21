// SPDX-License-Identifier: Apache-2.0
import {
  CompassIcon,
  FoldersIcon,
  LogOutIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Kbd } from '@cenacle/ui/components/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@cenacle/ui/components/sidebar';
import { Button } from '@cenacle/ui/components/button';
import { Logo } from '@cenacle/ui/brand';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { SettingsDialog } from '../auth/settings-dialog';
import { initials, useSignOut } from '../auth/sign-out';
import { categoriesQuery, channelsQuery, isConversation, type Channel } from '../chat/data';
import { NewConversationDialog } from '../chat/new-conversation-dialog';
import { usePresence, useWorkspacePresence } from '../chat/presence-state';
import { StatusMenu } from '../chat/status-menu';
import { PresenceIndicator } from './presence';
import { CategoriesDialog } from '../chat/categories-dialog';
import { useActiveWorkspace } from '../chat/active-workspace';
import { WorkspaceMenu } from '../chat/workspace-menu';
import { useQuickSwitcher } from '../chat/quick-switcher-state';
import { useActiveChannel } from '../chat/active-channel';
import { ChannelDirectory } from '../chat/channel-directory';
import { ChannelIcon } from '../chat/channel-icon';
import { CreateChannelDialog } from '../chat/create-channel-dialog';

/** The icon of a conversation: the other person's presence, or a group icon. */
function ConversationIcon({ channel }: { channel: Channel }) {
  const other = channel.kind === 'direct' ? channel.participants[0]?.id : undefined;
  const presence = usePresence(other);
  return channel.kind === 'direct' ? (
    <PresenceIndicator presence={presence} className="bg-transparent" />
  ) : (
    <UsersIcon aria-hidden strokeWidth={1.75} />
  );
}

function ChannelList({ channels }: { channels: Channel[] }) {
  const { t } = useTranslation();
  const { id: activeId } = useActiveChannel();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {channels.map((ch) => {
        const isActive = ch.id === activeId;
        const unread = ch.unread_count > 0;
        // Conversations are addressed to you: their count stands out like a
        // mention; channels are only marked as having something new.
        const counted = unread && (isConversation(ch) || ch.mention_count > 0);
        const count = isConversation(ch) ? ch.unread_count : ch.mention_count;
        return (
          <SidebarMenuItem key={ch.id} data-unread={unread || undefined}>
            <SidebarMenuButton
              isActive={isActive}
              className={cn(unread && 'font-semibold text-unread', (unread || counted) && 'pr-8')}
              render={
                <Link
                  to="/c/$channelId"
                  params={{ channelId: ch.id }}
                  aria-current={isActive ? 'page' : undefined}
                  // Picking a channel closes the drawer on phones.
                  onClick={() => isMobile && setOpenMobile(false)}
                />
              }
            >
              {isConversation(ch) ? (
                <ConversationIcon channel={ch} />
              ) : (
                <ChannelIcon channel={ch} labelled />
              )}
              <span>{ch.name}</span>
              {unread && (
                <span className="sr-only">
                  {t('dm.unread', { count: ch.unread_count })}
                  {ch.mention_count > 0 && `, ${t('mentions.unread', { count: ch.mention_count })}`}
                </span>
              )}
            </SidebarMenuButton>
            {counted ? (
              <SidebarMenuBadge
                aria-hidden
                className="rounded-full bg-mention text-mention-foreground peer-data-active/menu-button:text-mention-foreground peer-hover/menu-button:text-mention-foreground"
              >
                {count > 99 ? '99+' : count}
              </SidebarMenuBadge>
            ) : unread ? (
              <SidebarMenuBadge aria-hidden>
                <span className="size-2 rounded-full bg-unread" />
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

function ChannelListSkeleton() {
  return (
    <SidebarMenu>
      {[0, 1, 2].map((i) => (
        <SidebarMenuItem key={i}>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/**
 * Channels grouped by the administrator's categories, in their order; channels
 * without a category come first, under "Channels", with the channel actions.
 */
function ChannelsGroups() {
  const { t } = useTranslation();
  const { id: workspaceId, admin } = useActiveWorkspace();
  const channels = useQuery(channelsQuery);
  const categories = useQuery(categoriesQuery(workspaceId));
  const [dialog, setDialog] = useState<'create' | 'browse' | 'categories' | null>(null);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  const list = (channels.data ?? []).filter(
    (c) => c.workspace_id === workspaceId && !isConversation(c),
  );
  const known = new Set(categories.data?.map((c) => c.id));
  const loose = list.filter((c) => !c.category_id || !known.has(c.category_id));

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>{t('shell.channels')}</SidebarGroupLabel>
        {admin && (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarGroupAction
                  aria-label={t('channels.createTitle')}
                  onClick={() => setDialog('create')}
                />
              }
            >
              <PlusIcon strokeWidth={1.75} />
            </TooltipTrigger>
            <TooltipContent side="right">{t('channels.createTitle')}</TooltipContent>
          </Tooltip>
        )}
        <SidebarGroupContent>
          {channels.isPending ? <ChannelListSkeleton /> : <ChannelList channels={loose} />}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="text-muted-foreground"
                onClick={() => setDialog('browse')}
              >
                <CompassIcon aria-hidden strokeWidth={1.75} />
                <span>{t('channels.browse')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {admin && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="text-muted-foreground"
                  onClick={() => setDialog('categories')}
                >
                  <FoldersIcon aria-hidden strokeWidth={1.75} />
                  <span>{t('categories.manage')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {categories.data?.map((cat) => {
        const inCategory = list.filter((c) => c.category_id === cat.id);
        if (inCategory.length === 0) return null;
        return (
          <SidebarGroup key={cat.id}>
            <SidebarGroupLabel>{cat.name}</SidebarGroupLabel>
            <SidebarGroupContent>
              <ChannelList channels={inCategory} />
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
      <CreateChannelDialog open={dialog === 'create'} onOpenChange={close} />
      <ChannelDirectory open={dialog === 'browse'} onOpenChange={close} />
      {dialog === 'categories' && <CategoriesDialog open onOpenChange={close} />}
    </>
  );
}

/** Direct and group conversations of the workspace, newest activity first. */
function ConversationsGroup() {
  const { t } = useTranslation();
  const { id: workspaceId } = useActiveWorkspace();
  const channels = useQuery(channelsQuery);
  const [open, setOpen] = useState(false);
  useWorkspacePresence(workspaceId);
  const list = (channels.data ?? [])
    .filter((c) => c.workspace_id === workspaceId && isConversation(c))
    .sort((a, b) => b.unread_count - a.unread_count || a.name.localeCompare(b.name));
  if (!workspaceId) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('dm.title')}</SidebarGroupLabel>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarGroupAction aria-label={t('dm.newTitle')} onClick={() => setOpen(true)} />
          }
        >
          <PlusIcon strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent side="right">{t('dm.newTitle')}</TooltipContent>
      </Tooltip>
      <SidebarGroupContent>
        {list.length > 0 ? (
          <ChannelList channels={list} />
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t('dm.none')}</p>
        )}
      </SidebarGroupContent>
      {open && <NewConversationDialog workspaceId={workspaceId} open onOpenChange={setOpen} />}
    </SidebarGroup>
  );
}

export function ChannelSidebar({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const [settings, setSettings] = useState(false);
  const openSwitcher = useQuickSwitcher((s) => s.setOpen);

  return (
    <Sidebar
      collapsible={mobile ? 'offcanvas' : 'none'}
      className={mobile ? undefined : 'h-full w-full border-r border-sidebar-border'}
      role={mobile ? undefined : 'navigation'}
      aria-label={t('shell.channelNav')}
    >
      <SidebarHeader className="gap-2 border-b border-sidebar-border">
        {/* The lockup heads the channel list (desktop and the mobile drawer);
            narrow layouts show the icon in the top bar instead. */}
        <div className="flex items-center px-2 pt-1.5 pb-1">
          <Logo variant="lockup" size={24} />
        </div>
        {workspace ? <WorkspaceMenu workspace={workspace} /> : <div className="h-8" aria-hidden />}
        <Button
          variant="outline"
          className="w-full justify-start gap-2 bg-background font-normal text-muted-foreground"
          onClick={() => openSwitcher(true)}
        >
          <SearchIcon aria-hidden strokeWidth={1.75} />
          <span className="flex-1 text-left">{t('shell.jumpTo')}</span>
          <Kbd>Ctrl K</Kbd>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <ChannelsGroups />
        <ConversationsGroup />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <CurrentUser onSettings={() => setSettings(true)} />
      </SidebarFooter>
      {settings && <SettingsDialog open onOpenChange={setSettings} />}
    </Sidebar>
  );
}

function CurrentUser({ onSettings }: { onSettings: () => void }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const signOut = useSignOut();
  const name = user.display_name || user.email;

  return (
    <div className="flex items-center gap-2 px-1">
      <StatusMenu initials={initials(name)} />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium" data-testid="current-user">
          {name}
        </span>
        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={t('shell.settings')} onClick={onSettings}>
        <SettingsIcon strokeWidth={1.75} />
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('auth.signOut')}
              disabled={signOut.isPending}
              aria-busy={signOut.isPending || undefined}
              onClick={() => signOut.mutate()}
            />
          }
        >
          <LogOutIcon strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent side="top">{t('auth.signOut')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
