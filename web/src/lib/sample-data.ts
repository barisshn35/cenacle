// SPDX-License-Identifier: Apache-2.0

// Placeholder data until workspaces (v0.6) and presence (v0.7) come from the API.

export type Presence = 'online' | 'away' | 'dnd' | 'offline';

export interface SampleWorkspace {
  id: string;
  name: string;
  initials: string;
  mentions: number;
}

// One workspace until workspaces arrive (v0.6).
export const workspaces: SampleWorkspace[] = [
  { id: 'w-default', name: 'Cenacle', initials: 'CE', mentions: 0 },
];
