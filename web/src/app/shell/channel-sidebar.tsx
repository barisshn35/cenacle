// SPDX-License-Identifier: Apache-2.0
import {
  ChevronDownIcon,
  CompassIcon,
  FoldersIcon,
  LogOutIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@cenacle/ui/components/sidebar';
import { Button } from '@cenacle/ui/components/button';
import { Logo } from '@cenacle/ui/brand';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { workspaces } from '../../lib/sample-data';
import { useLayout } from '../../stores/layout';
import { PresenceIndicator } from './presence';
import { useSession } from '../auth/session';
import { initials, useSignOut } from '../auth/sign-out';
import { categoriesQuery, channelsQuery, type Channel } from '../chat/data';
import { CategoriesDialog } from '../chat/categories-dialog';
import { useQuickSwitcher } from '../chat/quick-switcher-state';
import { useActiveChannel } from '../chat/active-channel';
import { ChannelDirectory } from '../chat/channel-directory';
import { ChannelIcon } from '../chat/channel-icon';
import { CreateChannelDialog } from '../chat/create-channel-dialog';

function ChannelList({ channels }: { channels: Channel[] }) {
  const { id: activeId } = useActiveChannel();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {channels.map((ch) => {
        const isActive = ch.id === activeId;
        return (
          <SidebarMenuItem key={ch.id}>
            <SidebarMenuButton
              isActive={isActive}
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
              <ChannelIcon channel={ch} labelled />
              <span>{ch.name}</span>
            </SidebarMenuButton>
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
  const { permissions } = useSession();
  const channels = useQuery(channelsQuery);
  const categories = useQuery(categoriesQuery);
  const [dialog, setDialog] = useState<'create' | 'browse' | 'categories' | null>(null);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  const list = channels.data ?? [];
  const known = new Set(categories.data?.map((c) => c.id));
  const loose = list.filter((c) => !c.category_id || !known.has(c.category_id));

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>{t('shell.channels')}</SidebarGroupLabel>
        {permissions.create_channels && (
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
            {permissions.create_channels && (
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

export function ChannelSidebar({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const activeWorkspace = useLayout((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((w) => w.id === activeWorkspace) ?? workspaces[0]!;
  const notAvailable = () => toast(t('shell.notAvailable'));
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
        <Button
          variant="ghost"
          className="w-full justify-between px-2 text-[15px] font-semibold"
          onClick={notAvailable}
        >
          <span className="truncate">{workspace.name}</span>
          <ChevronDownIcon aria-hidden strokeWidth={1.75} />
        </Button>
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
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <CurrentUser onSettings={notAvailable} />
      </SidebarFooter>
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
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
        <span aria-hidden>{initials(name)}</span>
        <PresenceIndicator presence="online" className="absolute -right-1 -bottom-1" />
      </span>
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
