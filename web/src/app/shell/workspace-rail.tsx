// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon, SettingsIcon } from 'lucide-react';
import { Logo } from '@cenacle/ui/brand';
import { SettingsDialog } from '../auth/settings-dialog';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { cn } from '@cenacle/ui/lib/utils';
import { initials } from '../auth/sign-out';
import { useActiveWorkspace } from '../chat/active-workspace';
import { AddWorkspaceDialog } from '../chat/workspace-menu';
import { channelsQuery } from '../chat/data';
import { workspacesQuery } from '../chat/workspaces';

export function WorkspaceRail() {
  const { t } = useTranslation();
  const workspaces = useQuery(workspacesQuery);
  const { id: active } = useActiveWorkspace();
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const channels = useQuery(channelsQuery);
  const unread = new Set(
    (channels.data ?? []).filter((c) => c.unread_count > 0).map((c) => c.workspace_id),
  );

  return (
    <nav
      aria-label={t('shell.workspaceNav')}
      className="flex h-full w-16 shrink-0 flex-col items-center gap-2 bg-rail pb-3"
    >
      {/* The mark heads the rail, on the 56px band of every header. */}
      <Link
        to="/"
        aria-label={t('notFound.home')}
        // On the Night rail the arch is drawn in Bone in both themes.
        style={{ '--logo-ink': 'var(--brand-ink-on-dark)' } as CSSProperties}
        className="flex h-14 w-full shrink-0 items-center justify-center border-b border-sidebar-border outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset"
      >
        <Logo variant="icon" size={28} decorative />
      </Link>
      <ul className="mt-1 flex flex-col items-center gap-2">
        {(workspaces.data ?? []).map((w) => {
          const isActive = w.id === active;
          const hasUnread = !isActive && unread.has(w.id);
          return (
            <li key={w.id} className="relative flex w-full justify-center">
              <span
                aria-hidden
                className={cn(
                  'absolute top-1/2 start-0 w-1 -translate-y-1/2 rounded-e-full bg-sidebar-foreground transition-[height] duration-(--duration-base) ease-(--ease-out)',
                  isActive ? 'h-8' : hasUnread ? 'h-2' : 'h-0',
                )}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      to="/w/$workspaceId"
                      params={{ workspaceId: w.id }}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={hasUnread ? t('shell.workspaceUnread', { name: w.name }) : w.name}
                      className={cn(
                        'relative flex size-10 items-center justify-center overflow-hidden rounded-[10px] text-[13px] font-semibold transition-[box-shadow,background-color] duration-(--duration-base) ease-(--ease-out) outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-foreground ring-2 ring-sidebar-primary ring-offset-2 ring-offset-rail'
                          : 'bg-sidebar-hover text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                      )}
                    />
                  }
                >
                  {w.icon_url ? (
                    <img
                      src={w.icon_url}
                      alt=""
                      draggable={false}
                      className="size-full overflow-hidden rounded-[inherit] object-cover"
                    />
                  ) : (
                    <span aria-hidden>{initials(w.name)}</span>
                  )}
                </TooltipTrigger>
                <TooltipContent side="right">{w.name}</TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 h-px w-8 bg-sidebar-border" aria-hidden />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={t('shell.addWorkspace')}
              onClick={() => setAdding(true)}
              className="flex size-10 items-center justify-center rounded-[10px] border border-dashed border-sidebar-border text-sidebar-muted-foreground transition-colors outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            />
          }
        >
          <PlusIcon className="size-5" strokeWidth={1.75} aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="right">{t('shell.addWorkspace')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={t('shell.settings')}
              onClick={() => setSettings(true)}
              className="mt-auto flex size-10 items-center justify-center rounded-[10px] text-sidebar-muted-foreground transition-colors outline-none hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            />
          }
        >
          <SettingsIcon className="size-5" strokeWidth={1.75} aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="right">{t('shell.settings')}</TooltipContent>
      </Tooltip>
      {settings && <SettingsDialog open onOpenChange={setSettings} />}
      {adding && <AddWorkspaceDialog open onOpenChange={(o) => !o && setAdding(false)} />}
    </nav>
  );
}
