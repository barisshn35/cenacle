// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type MentionGroup = components['schemas']['MentionGroup'];
export type MentionGroupMember = components['schemas']['MentionGroupMember'];
export interface GroupList {
  groups: MentionGroup[];
  can_create: boolean;
  creation: 'members' | 'admins';
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const groupsQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['mention-groups', workspaceId],
    queryFn: () => apiFetch<GroupList>(`/api/workspaces/${workspaceId}/mention-groups`),
    enabled: !!workspaceId,
    staleTime: 5 * 60_000,
  });

export const groupQuery = (groupId: string) =>
  queryOptions({
    queryKey: ['mention-group', groupId],
    queryFn: () =>
      apiFetch<{ group: MentionGroup; members: MentionGroupMember[] }>(
        `/api/mention-groups/${groupId}`,
      ),
  });

export const createGroup = (
  workspaceId: string,
  body: {
    handle: string;
    name: string;
    description?: string;
    member_ids?: string[];
    directory_group?: string;
  },
) => apiFetch<MentionGroup>(`/api/workspaces/${workspaceId}/mention-groups`, json('POST', body));
export const updateGroup = (
  id: string,
  body: Partial<{ handle: string; name: string; description: string; archived: boolean }>,
) => apiFetch<MentionGroup>(`/api/mention-groups/${id}`, json('PATCH', body));
export const addGroupMembers = (id: string, userIds: string[]) =>
  apiFetch<void>(`/api/mention-groups/${id}/members`, json('POST', { user_ids: userIds }));
export const removeGroupMember = (id: string, userId: string) =>
  apiFetch<void>(`/api/mention-groups/${id}/members/${userId}`, { method: 'DELETE' });
export const setGroupManager = (id: string, userId: string, manager: boolean) =>
  apiFetch<void>(`/api/mention-groups/${id}/members/${userId}`, json('PATCH', { manager }));
export const setGroupCreation = (workspaceId: string, creation: GroupList['creation']) =>
  apiFetch<void>(
    `/api/workspaces/${workspaceId}/mention-groups/settings`,
    json('PUT', { creation }),
  );

/** A group's handle: as the server checks it (lower case, 1 to 30). */
export const HANDLE = /^[a-z0-9]([a-z0-9._-]{0,28}[a-z0-9])?$/;
/** Words that mention many already. */
export const RESERVED = new Set(['channel', 'everyone', 'here', 'admins', 'owners', 'all']);

/** "Backend team" → "backend-team": a handle to start from. */
export function suggestHandle(name: string): string {
  return name
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 30)
    .replace(/[^a-z0-9]+$/g, '');
}

const MENTION = /(^|[^\w@<])@([a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?)/gi;

/** The group handles a text mentions, as the server finds them. */
export function mentionedHandles(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION)) {
    const h = m[2]!.toLowerCase();
    if (!RESERVED.has(h)) out.add(h);
  }
  return [...out];
}

/** Groups that can be mentioned (not archived), by handle. */
export const mentionable = (groups: MentionGroup[] = []) =>
  new Map(groups.filter((g) => !g.archived).map((g) => [g.handle, g]));

/** The workspace's groups that can be mentioned, by handle. */
export function useMentionableGroups(workspaceId: string | undefined): Map<string, MentionGroup> {
  const list = useQuery(groupsQuery(workspaceId)).data?.groups;
  return useMemo(() => mentionable(list), [list]);
}

/** Whether a text mentions a group the reader is in. */
export function mentionsMyGroup(body: string, groups: Map<string, MentionGroup>): boolean {
  return mentionedHandles(body).some((h) => groups.get(h)?.is_member);
}
