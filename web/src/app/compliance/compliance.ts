// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';

export type Compliance = components['schemas']['Compliance'];
export type ChannelCompliance = components['schemas']['ChannelCompliance'];
export type LegalHold = components['schemas']['LegalHold'];
export type LegalHoldInput = components['schemas']['LegalHoldInput'];
export type AccessRule = components['schemas']['AccessRule'];

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const complianceQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['compliance', workspaceId],
    queryFn: () => apiFetch<Compliance>(`/api/workspaces/${workspaceId}/compliance`),
  });
export const setCompliance = (workspaceId: string, c: Compliance) =>
  apiFetch<Compliance>(`/api/workspaces/${workspaceId}/compliance`, json(c, 'PUT'));

export const memberAttributesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['member-attributes', workspaceId],
    queryFn: () =>
      apiFetch<{ members: { user_id: string; attributes: Record<string, string> }[] }>(
        `/api/workspaces/${workspaceId}/member-attributes`,
      ).then((r) => r.members),
  });
export const setMemberAttributes = (
  workspaceId: string,
  userId: string,
  attrs: Record<string, string>,
) =>
  apiFetch<{ removed: number }>(
    `/api/workspaces/${workspaceId}/member-attributes/${userId}`,
    json(attrs, 'PUT'),
  );

export const setChannelCompliance = (channelId: string, c: ChannelCompliance) =>
  apiFetch<{ removed: number }>(`/api/channels/${channelId}/compliance`, json(c, 'PUT'));

export const holdsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['legal-holds', workspaceId],
    queryFn: () =>
      apiFetch<{ holds: LegalHold[] }>(`/api/workspaces/${workspaceId}/legal-holds`).then(
        (r) => r.holds,
      ),
  });
export const createHold = (workspaceId: string, h: LegalHoldInput) =>
  apiFetch<LegalHold>(`/api/workspaces/${workspaceId}/legal-holds`, json(h));
export const updateHold = (id: string, h: LegalHoldInput) =>
  apiFetch<LegalHold>(`/api/legal-holds/${id}`, json(h, 'PUT'));
export const releaseHold = (id: string) =>
  apiFetch<LegalHold>(`/api/legal-holds/${id}/release`, { method: 'POST' });

/** Downloads an eDiscovery export as a file. */
export async function downloadExport(
  workspaceId: string,
  filter: {
    since?: string;
    until?: string;
    q?: string;
    channel_ids?: string[];
    user_ids?: string[];
  },
) {
  const params = new URLSearchParams();
  if (filter.since) params.set('since', new Date(`${filter.since}T00:00`).toISOString());
  if (filter.until) params.set('until', new Date(`${filter.until}T00:00`).toISOString());
  if (filter.q) params.set('q', filter.q);
  if (filter.channel_ids?.length) params.set('channel_ids', filter.channel_ids.join(','));
  if (filter.user_ids?.length) params.set('user_ids', filter.user_ids.join(','));
  const res = await fetch(`/api/workspaces/${workspaceId}/export?${params}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as ApiError['problem'] | undefined;
    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: res.statusText,
        status: res.status,
        code: `http_${res.status}`,
      },
    );
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cenacle-export-${new Date().toISOString().slice(0, 10)}.ndjson`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return blob.size;
}

export type Classification = components['schemas']['Classification'];

export const classificationsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['classifications', workspaceId],
    queryFn: () =>
      apiFetch<{ classifications: Classification[]; default_id: string | null }>(
        `/api/workspaces/${workspaceId}/classifications`,
      ),
    staleTime: 5 * 60_000,
  });
