// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { create } from 'zustand';
import { safeStorage } from '@cenacle/ui/lib/storage';
import { channelsQuery } from './data';
import { isWorkspaceAdmin, workspacesQuery, type Workspace } from './workspaces';

const KEY = 'cenacle.workspace';

/** The workspace last opened on this device, to come back to. */
export const useLastWorkspace = create<{ id: string | null; set: (id: string) => void }>()(
  (set) => ({
    id: safeStorage.get(KEY),
    set: (id) => {
      safeStorage.set(KEY, id);
      set({ id });
    },
  }),
);

/**
 * The workspace in view: the one in the URL (/w/<id>), else the current
 * channel's, else the last one used, else the default one.
 */
export function useActiveWorkspace(): {
  id: string | undefined;
  workspace: Workspace | undefined;
  admin: boolean;
} {
  const { workspaceId, channelId } = useParams({ strict: false });
  const channels = useQuery(channelsQuery);
  const workspaces = useQuery(workspacesQuery);
  const last = useLastWorkspace((s) => s.id);
  const list = workspaces.data ?? [];
  const fromChannel = channels.data?.find((c) => c.id === channelId)?.workspace_id;
  const candidates = [workspaceId, fromChannel, last, list[0]?.id];
  const id = candidates.find((c) => c && list.some((w) => w.id === c)) ?? undefined;
  const workspace = list.find((w) => w.id === id);
  return { id, workspace, admin: isWorkspaceAdmin(workspace) };
}

/** Remembers the workspace in view, to come back to it next time. */
export function useRememberWorkspace(): void {
  const { id } = useActiveWorkspace();
  const remember = useLastWorkspace((s) => s.set);
  useEffect(() => {
    if (id) remember(id);
  }, [id, remember]);
}
