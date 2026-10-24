// SPDX-License-Identifier: AGPL-3.0-only
import { LogOutIcon, SearchIcon, SettingsIcon, SquarePenIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Kbd } from '@cenacle/ui/components/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from '@cenacle/ui/components/sidebar';
import { Button } from '@cenacle/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { useSession } from '../auth/session';
import { SettingsDialog } from '../auth/settings-dialog';
import { useSignOut } from '../auth/sign-out';
import { NewConversationDialog } from '../chat/new-conversation-dialog';
import { StatusMenu } from '../chat/status-menu';
import { ProfileDialogs } from '../profile/profile-dialogs';
import { StatusLine } from '../profile/profile-card';
import { useProfile } from '../profile/profiles';
import { useActiveWorkspace } from '../chat/active-workspace';
import { WorkspaceMenu } from '../chat/workspace-menu';
import { useQuickSwitcher } from '../chat/quick-switcher-state';
import { HomeLinks } from '../threads/home-links';
import { SidebarSections } from './sidebar-sections';

export function ChannelSidebar({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const [settings, setSettings] = useState(false);
  const openSwitcher = useQuickSwitcher((s) => s.setOpen);

  return (
    <Sidebar
      collapsible={mobile ? 'offcanvas' : 'none'}
      className={mobile ? undefined : 'h-full w-full border-e border-sidebar-border'}
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
          className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-hover px-2.5 text-start text-[13.5px] text-sidebar-muted-foreground transition-colors outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={() => openSwitcher(true)}
        >
          <SearchIcon aria-hidden className="size-4" strokeWidth={1.75} />
          <span className="flex-1">{t('shell.jumpTo')}</span>
          <Kbd className="bg-transparent font-mono text-sidebar-muted-foreground">Ctrl K</Kbd>
        </button>
      </SidebarHeader>

      <SidebarContent>
        <HomeLinks />
        <SidebarSections />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <CurrentUser onSettings={mobile ? () => setSettings(true) : undefined} />
      </SidebarFooter>
      {settings && <SettingsDialog open onOpenChange={setSettings} />}
    </Sidebar>
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
