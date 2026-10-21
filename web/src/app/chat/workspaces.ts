// SPDX-License-Identifier: Apache-2.0
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type Workspace = components['schemas']['Workspace'];
export type WorkspaceMember = components['schemas']['WorkspaceMember'];
export type Invite = components['schemas']['Invite'];
export type InvitePreview = components['schemas']['InvitePreview'];

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Owners and admins run a workspace. */
export const isWorkspaceAdmin = (w: Pick<Workspace, 'role'> | undefined) =>
  w?.role === 'owner' || w?.role === 'admin';

/** The user's workspaces, the default one first. */
export const workspacesQuery = queryOptions({
  queryKey: ['workspaces'],
  queryFn: () => apiFetch<{ workspaces: Workspace[] }>('/api/workspaces').then((r) => r.workspaces),
  staleTime: 5 * 60_000,
});

export const createWorkspace = (name: string) =>
  apiFetch<Workspace>('/api/workspaces', json({ name }));
export const renameWorkspace = (id: string, name: string) =>
  apiFetch<Workspace>(`/api/workspaces/${id}`, json({ name }, 'PATCH'));

export const workspaceMembersQuery = (id: string) =>
  queryOptions({
    queryKey: ['workspace-members', id],
    queryFn: () =>
      apiFetch<{ members: WorkspaceMember[] }>(`/api/workspaces/${id}/members`).then(
        (r) => r.members,
      ),
  });
export const setWorkspaceRole = (id: string, userId: string, role: Workspace['role']) =>
  apiFetch<WorkspaceMember>(`/api/workspaces/${id}/members/${userId}`, json({ role }, 'PATCH'));
export const removeWorkspaceMember = (id: string, userId: string) =>
  apiFetch<void>(`/api/workspaces/${id}/members/${userId}`, { method: 'DELETE' });

export const invitesQuery = (id: string) =>
  queryOptions({
    queryKey: ['invites', id],
    queryFn: () =>
      apiFetch<{ invites: Invite[] }>(`/api/workspaces/${id}/invites`).then((r) => r.invites),
  });
export const createInvite = (
  id: string,
  options: { expires_in_hours: number; max_uses: number | null },
) => apiFetch<{ invite: Invite; token: string }>(`/api/workspaces/${id}/invites`, json(options));
export const revokeInvite = (id: string, inviteId: string) =>
  apiFetch<void>(`/api/workspaces/${id}/invites/${inviteId}`, { method: 'DELETE' });

export const invitePreviewQuery = (token: string) =>
  queryOptions({
    queryKey: ['invite', token],
    queryFn: () => apiFetch<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`),
    retry: false,
  });
export const acceptInvite = (token: string) =>
  apiFetch<Workspace>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });

/** The link to share for an invitation token. */
export const inviteLink = (token: string) => `${location.origin}/invite/${token}`;

/** Extracts the token from a pasted link or token. */
export function inviteToken(input: string): string {
  const text = input.trim();
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(text);
  return match ? match[1]! : text;
}

/** Workspaces, their members or the user's rights changed: reload. */
export async function reloadWorkspaces(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  await queryClient.invalidateQueries({ queryKey: ['channels'] });
}
