// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';
import type { Channel } from '../chat/data';

export type FederationConnection = components['schemas']['FederationConnection'];
export type ChannelOffer = components['schemas']['ChannelOffer'];
export type ChannelShare = components['schemas']['ChannelShare'];

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const federationQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['federation', workspaceId],
    queryFn: () =>
      apiFetch<{ connections: FederationConnection[]; offers: ChannelOffer[] }>(
        `/api/workspaces/${workspaceId}/federation`,
      ),
  });

export const createInvite = (workspaceId: string, name: string) =>
  apiFetch<{ code: string; expires_at: string }>(
    `/api/workspaces/${workspaceId}/federation/invites`,
    json({ name }),
  );
export const connect = (workspaceId: string, code: string, name: string) =>
  apiFetch<FederationConnection>(
    `/api/workspaces/${workspaceId}/federation/connections`,
    json({ code, name }),
  );
export const setConnectionEnabled = (id: string, enabled: boolean) =>
  apiFetch<FederationConnection>(`/api/federation/connections/${id}`, json({ enabled }, 'PATCH'));
export const removeConnection = (id: string) =>
  apiFetch<void>(`/api/federation/connections/${id}`, { method: 'DELETE' });
export const acceptOffer = (id: string) =>
  apiFetch<Channel>(`/api/federation/offers/${id}/accept`, { method: 'POST' });
export const declineOffer = (id: string) =>
  apiFetch<void>(`/api/federation/offers/${id}`, { method: 'DELETE' });

export const sharesQuery = (channelId: string) =>
  queryOptions({
    queryKey: ['shares', channelId],
    queryFn: () =>
      apiFetch<{ shares: ChannelShare[] }>(`/api/channels/${channelId}/shares`).then(
        (r) => r.shares,
      ),
  });
export const shareChannel = (channelId: string, connectionId: string) =>
  apiFetch<ChannelShare>(
    `/api/channels/${channelId}/shares`,
    json({ connection_id: connectionId }),
  );
export const unshareChannel = (channelId: string, connectionId: string) =>
  apiFetch<void>(`/api/channels/${channelId}/shares/${connectionId}`, { method: 'DELETE' });
