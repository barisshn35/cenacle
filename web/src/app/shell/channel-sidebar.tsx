// SPDX-License-Identifier: Apache-2.0
import {
  ChevronDownIcon,
  HashIcon,
  LockIcon,
  MegaphoneIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Kbd } from '@cenacle/ui/components/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@cenacle/ui/components/sidebar';
import { Button } from '@cenacle/ui/components/button';
import { cn } from '@cenacle/ui/lib/utils';
import { categories, directMessages, workspaces, type ChannelKind } from '../../lib/sample-data';
import { useLayout } from '../../stores/layout';
import { PresenceIndicator } from './presence';

const channelIcon: Record<ChannelKind, typeof HashIcon> = {
  public: HashIcon,
  private: LockIcon,
  announcement: MegaphoneIcon,
};

function MentionBadge({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <SidebarMenuBadge className="rounded-full bg-mention px-1.5 text-mention-foreground peer-data-active/menu-button:text-mention-foreground">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{t('shell.mentions', { count })}</span>
    </SidebarMenuBadge>
  );
}

/** Unread without mentions = bold name + small dot (never a number). */
function UnreadDot() {
  const { t } = useTranslation();
  return (
    <SidebarMenuBadge>
      <span aria-hidden className="size-2 rounded-full bg-unread" />
      <span className="sr-only">{t('shell.unread')}</span>
    </SidebarMenuBadge>
  );
}

export function ChannelSidebar({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const activeWorkspace = useLayout((s) => s.activeWorkspaceId);
  const activeChannel = useLayout((s) => s.activeChannelId);
  const selectChannel = useLayout((s) => s.selectChannel);
  const workspace = workspaces.find((w) => w.id === activeWorkspace) ?? workspaces[0]!;
  const notAvailable = () => toast(t('shell.notAvailable'));

  return (
    <Sidebar
      collapsible={mobile ? 'offcanvas' : 'none'}
      className={mobile ? undefined : 'h-full w-full border-r border-sidebar-border'}
      aria-label={t('shell.channelNav')}
    >
      <SidebarHeader className="gap-2 border-b border-sidebar-border">
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
        {categories.map((cat) => (
          <SidebarGroup key={cat.id}>
            <SidebarGroupLabel>{cat.name}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {cat.channels.map((ch) => {
                  const Icon = channelIcon[ch.kind];
                  const isActive = ch.id === activeChannel;
                  return (
                    <SidebarMenuItem key={ch.id}>
                      <SidebarMenuButton
                        isActive={isActive}
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => selectChannel(ch.id)}
                        className={cn(ch.unread && !isActive && 'font-semibold text-foreground')}
                      >
                        <Icon aria-label={t(`shell.channelTypes.${ch.kind}`)} strokeWidth={1.75} />
                        <span>{ch.name}</span>
                      </SidebarMenuButton>
                      {ch.mentions > 0 ? (
                        <MentionBadge count={ch.mentions} />
                      ) : (
                        ch.unread && !isActive && <UnreadDot />
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        <SidebarGroup>
          <SidebarGroupLabel>{t('shell.directMessages')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {directMessages.map((dm) => (
                <SidebarMenuItem key={dm.id}>
                  <SidebarMenuButton
                    isActive={dm.id === activeChannel}
                    onClick={() => selectChannel(dm.id)}
                    className={cn(dm.unread && 'font-semibold text-foreground')}
                  >
                    <span className="relative flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold">
                      <span aria-hidden>{dm.initials}</span>
                      <PresenceIndicator
                        presence={dm.presence}
                        className="absolute -right-1 -bottom-1"
                      />
                    </span>
                    <span>{dm.name}</span>
                  </SidebarMenuButton>
                  {dm.mentions > 0 && <MentionBadge count={dm.mentions} />}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center gap-2 px-1">
          <span className="relative flex size-8 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
            <span aria-hidden>YB</span>
            <PresenceIndicator presence="online" className="absolute -right-1 -bottom-1" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium">{t('shell.you')}</span>
            <span className="truncate text-xs text-muted-foreground">
              {t('shell.presence.online')}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('shell.settings')}
            onClick={notAvailable}
          >
            <SettingsIcon strokeWidth={1.75} />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
