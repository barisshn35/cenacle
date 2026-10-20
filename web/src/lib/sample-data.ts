// SPDX-License-Identifier: Apache-2.0

// Placeholder data for the v0.1 shell. Real data arrives with the API (v0.5+).

export type ChannelKind = 'public' | 'private' | 'announcement';
export type Presence = 'online' | 'away' | 'dnd' | 'offline';

export interface SampleWorkspace {
  id: string;
  name: string;
  initials: string;
  mentions: number;
}

export interface SampleChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  unread: boolean;
  mentions: number;
  topic: string;
  members: number;
}

export interface SampleCategory {
  id: string;
  name: string;
  channels: SampleChannel[];
}

export interface SampleDirectMessage {
  id: string;
  name: string;
  initials: string;
  presence: Presence;
  unread: boolean;
  mentions: number;
}

export const workspaces: SampleWorkspace[] = [
  { id: 'w-ops', name: 'Operations', initials: 'OP', mentions: 0 },
  { id: 'w-platform', name: 'Platform', initials: 'PL', mentions: 2 },
  { id: 'w-design', name: 'Design', initials: 'DS', mentions: 0 },
];

export const categories: SampleCategory[] = [
  {
    id: 'cat-info',
    name: 'Information',
    channels: [
      {
        id: 'c-announcements',
        name: 'announcements',
        kind: 'announcement',
        unread: true,
        mentions: 0,
        topic: 'Company-wide updates. Read only.',
        members: 128,
      },
      {
        id: 'c-general',
        name: 'general',
        kind: 'public',
        unread: false,
        mentions: 0,
        topic: 'Anything and everything.',
        members: 124,
      },
    ],
  },
  {
    id: 'cat-eng',
    name: 'Engineering',
    channels: [
      {
        id: 'c-ops-alerts',
        name: 'ops-alerts',
        kind: 'public',
        unread: true,
        mentions: 3,
        topic: 'Alerts from monitoring. Acknowledge in thread.',
        members: 18,
      },
      {
        id: 'c-deploys',
        name: 'deploys',
        kind: 'public',
        unread: true,
        mentions: 0,
        topic: 'Release and deployment log.',
        members: 42,
      },
      {
        id: 'c-backend',
        name: 'backend',
        kind: 'private',
        unread: false,
        mentions: 0,
        topic: 'Chat server and IdP.',
        members: 9,
      },
    ],
  },
];

export const directMessages: SampleDirectMessage[] = [
  {
    id: 'dm-ayse',
    name: 'Ayşe Yılmaz',
    initials: 'AY',
    presence: 'online',
    unread: true,
    mentions: 1,
  },
  {
    id: 'dm-mert',
    name: 'Mert Kaya',
    initials: 'MK',
    presence: 'away',
    unread: false,
    mentions: 0,
  },
  {
    id: 'dm-elif',
    name: 'Elif Demir',
    initials: 'ED',
    presence: 'dnd',
    unread: false,
    mentions: 0,
  },
  {
    id: 'dm-can',
    name: 'Can Öztürk',
    initials: 'CÖ',
    presence: 'offline',
    unread: false,
    mentions: 0,
  },
];

export function findChannel(id: string): SampleChannel | undefined {
  return categories.flatMap((c) => c.channels).find((c) => c.id === id);
}
