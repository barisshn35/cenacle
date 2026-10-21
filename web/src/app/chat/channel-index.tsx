// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { AppShell } from '../shell/app-shell';
import { useActiveWorkspace } from './active-workspace';
import { channelsQuery } from './data';
import { workspacesQuery } from './workspaces';

/**
 * "/" and "/w/<workspace>" open the first channel to talk in of the workspace
 * (the last one used, or the default one).
 */
export function ChannelIndex() {
  const { t } = useTranslation();
  const channels = useQuery(channelsQuery);
  const workspaces = useQuery(workspacesQuery);
  const { id: workspaceId } = useActiveWorkspace();
  if (channels.isError || workspaces.isError) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <ErrorState
          problem={channels.error instanceof ApiError ? channels.error.problem : { status: 500 }}
          actions={
            <Button
              onClick={() => {
                void channels.refetch();
                void workspaces.refetch();
              }}
            >
              {t('ui:errors.retry')}
            </Button>
          }
        />
      </main>
    );
  }
  if (!channels.data || !workspaces.data) return null;
  const list = channels.data.filter((c) => c.workspace_id === workspaceId);
  // The first channel to talk in, not an announcement channel.
  const target =
    list.find((c) => c.kind === 'standard' && c.can_post) ??
    list.find((c) => c.can_post) ??
    list[0];
  // Without a channel to open, the shell shows the workspace with a way in.
  if (!target) return <AppShell />;
  return <Navigate to="/c/$channelId" params={{ channelId: target.id }} replace />;
}
