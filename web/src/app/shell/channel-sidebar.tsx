// SPDX-License-Identifier: Apache-2.0
import {
  ChevronDownIcon,
  CompassIcon,
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
import { channelsQuery } from '../chat/data';
import { useActiveChannel } from '../chat/active-channel';
import { ChannelDirectory } from '../chat/channel-directory';
import { ChannelIcon } from '../chat/channel-icon';
import { CreateChannelDialog } from '../chat/create-channel-dialog';

function ChannelList() {
  const { t } = useTranslation();
  const channels = useQuery(channelsQuery);
  const { id: activeId } = useActiveChannel();
  const { isMobile, setOpenMobile } = useSidebar();

  if (channels.isPending) {
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
  return (
    <SidebarMenu>
      {(channels.data ?? []).map((ch) => {
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
              <ChannelIcon kind={ch.kind} label={t(`channels.kinds.${ch.kind}`)} />
              <span>{ch.name}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

function ChannelsGroup() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('shell.channels')}</SidebarGroupLabel>
      {permissions.create_channels && (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarGroupAction
                aria-label={t('channels.createTitle')}
                onClick={() => setCreating(true)}
              />
            }
          >
            <PlusIcon strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent side="right">{t('channels.createTitle')}</TooltipContent>
        </Tooltip>
      )}
      <SidebarGroupContent>
        <ChannelList />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="text-muted-foreground" onClick={() => setBrowsing(true)}>
              <CompassIcon aria-hidden strokeWidth={1.75} />
              <span>{t('channels.browse')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
      <CreateChannelDialog open={creating} onOpenChange={setCreating} />
      <ChannelDirectory open={browsing} onOpenChange={setBrowsing} />
    </SidebarGroup>
  );
}

export function ChannelSidebar({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const activeWorkspace = useLayout((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((w) => w.id === activeWorkspace) ?? workspaces[0]!;
  const notAvailable = () => toast(t('shell.notAvailable'));

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
          onClick={notAvailable}
        >
          <SearchIcon aria-hidden strokeWidth={1.75} />
          <span className="flex-1 text-left">{t('shell.jumpTo')}</span>
          <Kbd>Ctrl K</Kbd>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <ChannelsGroup />
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
