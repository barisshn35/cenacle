// SPDX-License-Identifier: Apache-2.0
import { ApiError, apiFetch } from '../api/client';

/** Domain models; generated OpenAPI output is updated by the operator's make gen. */
export interface CallParticipant {
  id: string;
  user_id: string | null;
  state: 'reserved' | 'connected' | 'reconnecting' | 'left';
  joined_at: string | null;
  left_at: string | null;
}
export interface Call {
  id: string;
  channel_id: string;
  state: 'ringing' | 'active' | 'ended';
  revision: number;
  created_at: string;
  ring_until: string | null;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string;
  participants: CallParticipant[];
}
export interface CallSettings {
  enabled: boolean;
  guest_start: boolean;
  max_participants: number;
  max_bitrate: number;
  available: boolean;
}
export interface CallAdmission {
  token: string;
  expires_in: number;
  signaling_path: string;
  participant_id: string;
  ice_servers?: RTCIceServer[];
}
const id = encodeURIComponent;
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export const calls = {
  start: (channelID: string, nonce: string): Promise<Call> =>
    apiFetch(`/api/channels/${id(channelID)}/calls`, json({ nonce })),
  current: async (channelID: string, signal?: AbortSignal): Promise<Call | null> => {
    try {
      return await apiFetch(`/api/channels/${id(channelID)}/call`, { signal, cache: 'no-store' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  get: (callID: string, signal?: AbortSignal): Promise<Call> =>
    apiFetch(`/api/calls/${id(callID)}`, { signal, cache: 'no-store' }),
  admit: (callID: string, signal?: AbortSignal): Promise<CallAdmission> =>
    apiFetch(`/api/calls/${id(callID)}/token`, { method: 'POST', signal, cache: 'no-store' }),
  answer: (callID: string, answer: 'accept' | 'decline'): Promise<Call> =>
    apiFetch(`/api/calls/${id(callID)}/answer`, json({ answer })),
  leave: (callID: string): Promise<void> =>
    apiFetch(`/api/calls/${id(callID)}/leave`, { method: 'POST' }),
  settings: (workspaceID: string): Promise<CallSettings> =>
    apiFetch(`/api/workspaces/${id(workspaceID)}/calls/settings`, { cache: 'no-store' }),
  updateSettings: (
    workspaceID: string,
    settings: Omit<CallSettings, 'available'>,
  ): Promise<CallSettings> =>
    apiFetch(`/api/workspaces/${id(workspaceID)}/calls/settings`, {
      ...json({
        enabled: settings.enabled,
        guest_start: settings.guest_start,
        max_participants: settings.max_participants,
        max_bitrate: settings.max_bitrate,
      }),
      method: 'PUT',
    }),
};
