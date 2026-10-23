// SPDX-License-Identifier: AGPL-3.0-only
import {
  BellOffIcon,
  ChevronDownIcon,
  CompassIcon,
  FoldersIcon,
  LogOutIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { SettingsDialog } from '../auth/settings-dialog';
import { useSignOut } from '../auth/sign-out';
import { categoriesQuery, channelsQuery, isConversation, type Channel } from '../chat/data';
import { NewConversationDialog } from '../chat/new-conversation-dialog';
import { usePresence, useWorkspacePresence } from '../chat/presence-state';
import { StatusMenu } from '../chat/status-menu';
import { useMutedChannels } from '../notifications/muted';
import { ProfileDialogs } from '../profile/profile-dialogs';
import { StatusLine } from '../profile/profile-card';
import { useProfile } from '../profile/profiles';
import { PresenceIndicator } from './presence';
import { CategoriesDialog } from '../chat/categories-dialog';
import { useActiveWorkspace } from '../chat/active-workspace';
import { WorkspaceMenu } from '../chat/workspace-menu';
import { useQuickSwitcher } from '../chat/quick-switcher-state';
import { useActiveChannel } from '../chat/active-channel';
import { ChannelDirectory } from '../chat/channel-directory';
import { ChannelIcon } from '../chat/channel-icon';
import { CreateChannelDialog } from '../chat/create-channel-dialog';
import { HomeLinks } from '../threads/home-links';

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
  const muted = useMutedChannels();
  return (
    <SidebarMenu>
      {channels.map((ch) => {
        const isActive = ch.id === activeId;
        const isMuted = muted.has(ch.id);
        // Muted: new messages stay quiet; mentions still show.
        const unread = ch.unread_count > 0 && (!isMuted || ch.mention_count > 0);
        // Conversations are addressed to you: their count stands out like a
        // mention; channels are only marked as having something new.
        const counted = unread && ((isConversation(ch) && !isMuted) || ch.mention_count > 0);
        const count = isConversation(ch) && !isMuted ? ch.unread_count : ch.mention_count;
        return (
          <SidebarMenuItem key={ch.id} data-unread={unread || undefined}>
            <SidebarMenuButton
              isActive={isActive}
              className={cn(
                unread && 'font-semibold text-sidebar-foreground',
                isMuted && !unread && 'opacity-70',
                (unread || counted) && 'pr-8',
              )}
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
              {isMuted && (
                <>
                  <BellOffIcon
                    aria-hidden
                    className="ml-auto size-3.5 shrink-0 opacity-70"
                    strokeWidth={1.75}
                  />
                  <span className="sr-only">{t('notifications.mutedLabel')}</span>
                </>
              )}
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
                <span className="size-2 rounded-full bg-sidebar-foreground" />
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
  const [open, setOpen] = useState(true);
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
        <SectionLabel label={t('shell.channels')} open={open} onToggle={() => setOpen(!open)} />
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
        <SidebarGroupContent hidden={!open}>
          {channels.isPending ? <ChannelListSkeleton /> : <ChannelList channels={loose} />}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setDialog('browse')}>
                <CompassIcon aria-hidden strokeWidth={1.75} />
                <span>{t('channels.browse')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {admin && (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setDialog('categories')}>
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
  const [shown, setShown] = useState(true);
  useWorkspacePresence(workspaceId);
  const list = (channels.data ?? [])
    .filter((c) => c.workspace_id === workspaceId && isConversation(c))
    .sort((a, b) => b.unread_count - a.unread_count || a.name.localeCompare(b.name));
  if (!workspaceId) return null;
  return (
    <SidebarGroup>
      <SectionLabel label={t('dm.title')} open={shown} onToggle={() => setShown(!shown)} />
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
      <SidebarGroupContent hidden={!shown}>
        {list.length > 0 ? (
          <ChannelList channels={list} />
        ) : (
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">{t('dm.none')}</p>
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
      <SidebarHeader className="gap-2 border-b border-sidebar-border px-2 pt-2 pb-3">
        <div className="flex min-h-10 items-center gap-1">
          <div className="min-w-0 flex-1">
            {workspace ? (
              <WorkspaceMenu workspace={workspace} />
            ) : (
              <div className="h-8" aria-hidden />
            )}
          </div>
          <NewMessageButton />
        </div>
        <button
          type="button"
          className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-hover px-2.5 text-left text-[13.5px] text-sidebar-muted-foreground transition-colors outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={() => openSwitcher(true)}
        >
          <SearchIcon aria-hidden className="size-4" strokeWidth={1.75} />
          <span className="flex-1">{t('shell.jumpTo')}</span>
          <Kbd className="bg-transparent font-mono text-sidebar-muted-foreground">Ctrl K</Kbd>
        </button>
      </SidebarHeader>

      <SidebarContent>
        <HomeLinks />
        <ChannelsGroups />
        <ConversationsGroup />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <CurrentUser onSettings={mobile ? () => setSettings(true) : undefined} />
      </SidebarFooter>
      {settings && <SettingsDialog open onOpenChange={setSettings} />}
    </Sidebar>
  );
}

/** Section headers fold their list away; the state is part of the button. */
function SectionLabel({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <SidebarGroupLabel
      render={<button type="button" aria-expanded={open} onClick={onToggle} />}
      className="hit-target w-fit gap-1.5 pr-3 hover:text-sidebar-foreground"
    >
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className={cn(
          'size-3.5! transition-transform duration-(--duration-base) ease-(--ease-out)',
          !open && '-rotate-90',
        )}
      />
      {label}
    </SidebarGroupLabel>
  );
}

/** Start a direct or group conversation, from the head of the sidebar. */
function NewMessageButton() {
  const { t } = useTranslation();
  const { id: workspaceId } = useActiveWorkspace();
  const [open, setOpen] = useState(false);
  if (!workspaceId) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('dm.compose')}
              className="text-sidebar-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
              onClick={() => setOpen(true)}
            />
          }
        >
          <SquarePenIcon strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('dm.compose')}</TooltipContent>
      </Tooltip>
      {open && <NewConversationDialog workspaceId={workspaceId} open onOpenChange={setOpen} />}
    </>
  );
}

function CurrentUser({ onSettings }: { onSettings?: () => void }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const signOut = useSignOut();
  const name = user.display_name || user.email;
  const profile = useProfile(user.id);

  return (
    <div className="flex items-center gap-2 px-1">
      <StatusMenu name={name} />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium" data-testid="current-user">
          {name}
        </span>
        {profile?.status ? (
          <StatusLine status={profile.status} className="truncate text-xs" />
        ) : (
          <span className="truncate text-xs text-sidebar-muted-foreground">
            {profile?.username ? `@${profile.username}` : user.email}
          </span>
        )}
      </div>
      <ProfileDialogs />
      {onSettings && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('shell.settings')}
          className="text-sidebar-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
          onClick={onSettings}
        >
          <SettingsIcon strokeWidth={1.75} />
        </Button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('auth.signOut')}
              className="text-sidebar-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
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
