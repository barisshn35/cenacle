// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { cn } from '@cenacle/ui/lib/utils';
import { initials } from '../auth/sign-out';
import { useActiveWorkspace } from '../chat/active-workspace';
import { AddWorkspaceDialog } from '../chat/workspace-menu';
import { workspacesQuery } from '../chat/workspaces';

export function WorkspaceRail() {
  const { t } = useTranslation();
  const workspaces = useQuery(workspacesQuery);
  const { id: active } = useActiveWorkspace();
  const [adding, setAdding] = useState(false);

  return (
    <nav
      aria-label={t('shell.workspaceNav')}
      className="flex h-full w-[72px] shrink-0 flex-col items-center gap-2 border-r border-sidebar-border bg-rail py-3"
    >
      <ul className="flex flex-col items-center gap-2">
        {(workspaces.data ?? []).map((w) => {
          const isActive = w.id === active;
          return (
            <li key={w.id} className="relative flex w-full justify-center">
              <span
                aria-hidden
                className={cn(
                  'absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height] duration-(--duration-base) ease-(--ease-out)',
                  isActive ? 'h-8' : 'h-0',
                )}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      to="/w/$workspaceId"
                      params={{ workspaceId: w.id }}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={w.name}
                      className={cn(
                        'relative flex size-12 items-center justify-center rounded-2xl text-sm font-semibold transition-[border-radius,background-color] duration-(--duration-base) ease-(--ease-out) outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'rounded-xl bg-primary text-primary-foreground'
                          : 'bg-sidebar-accent text-sidebar-accent-foreground hover:rounded-xl hover:bg-primary/85 hover:text-primary-foreground',
                      )}
                    />
                  }
                >
                  <span aria-hidden>{initials(w.name)}</span>
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
              className="flex size-12 items-center justify-center rounded-2xl border border-dashed border-sidebar-border text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <PlusIcon className="size-5" strokeWidth={1.75} aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="right">{t('shell.addWorkspace')}</TooltipContent>
      </Tooltip>
      {adding && <AddWorkspaceDialog open onOpenChange={(o) => !o && setAdding(false)} />}
    </nav>
  );
}
