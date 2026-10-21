// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { presenceQuery, type PresenceStatus } from './data';

/** How long a typing notice shows without a new one (the server sends every 2 s at most). */
export const TYPING_MS = 6_000;

interface Typist {
  userId: string;
  name: string;
  until: number;
}

interface LiveState {
  /** Status by user id; missing means offline. */
  presence: Record<string, PresenceStatus>;
  /** Who is typing, by channel id. */
  typing: Record<string, Typist[]>;
  setPresence(userId: string, status: PresenceStatus): void;
  loadPresence(list: { user_id: string; status: PresenceStatus }[]): void;
  startTyping(channelId: string, userId: string, name: string, now?: number): void;
  stopTyping(channelId: string, userId: string): void;
  expireTyping(now?: number): void;
}

/** Short-lived state from the live connection: presence and typing. */
export const useLive = create<LiveState>()((set) => ({
  presence: {},
  typing: {},
  setPresence: (userId, status) => set((s) => ({ presence: { ...s.presence, [userId]: status } })),
  loadPresence: (list) =>
    set((s) => ({
      presence: { ...s.presence, ...Object.fromEntries(list.map((p) => [p.user_id, p.status])) },
    })),
  startTyping: (channelId, userId, name, now = Date.now()) =>
    set((s) => ({
      typing: {
        ...s.typing,
        [channelId]: [
          ...(s.typing[channelId] ?? []).filter((x) => x.userId !== userId),
          { userId, name, until: now + TYPING_MS },
        ],
      },
    })),
  stopTyping: (channelId, userId) =>
    set((s) =>
      s.typing[channelId]?.some((x) => x.userId === userId)
        ? {
            typing: {
              ...s.typing,
              [channelId]: s.typing[channelId]!.filter((x) => x.userId !== userId),
            },
          }
        : s,
    ),
  expireTyping: (now = Date.now()) =>
    set((s) => {
      let changed = false;
      const typing: Record<string, Typist[]> = {};
      for (const [id, list] of Object.entries(s.typing)) {
        const live = list.filter((x) => x.until > now);
        if (live.length !== list.length) changed = true;
        if (live.length) typing[id] = live;
      }
      return changed ? { typing } : s;
    }),
}));

export function usePresence(userId: string | undefined): PresenceStatus {
  return useLive((s) => (userId && s.presence[userId]) || 'offline');
}

/** Loads a workspace's presence when it opens (changes arrive live). */
export function useWorkspacePresence(workspaceId: string | undefined) {
  const query = useQuery(presenceQuery(workspaceId));
  const load = useLive((s) => s.loadPresence);
  useEffect(() => {
    if (query.data) load(query.data);
  }, [query.data, load]);
}
