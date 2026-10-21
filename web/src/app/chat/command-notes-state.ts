// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { CommandResult } from './commands';

/** An answer to a command that only its caller sees ("ephemeral"). */
export interface CommandNote {
  id: string;
  channelId: string;
  command: string;
  text: string;
  attachments: NonNullable<CommandResult['attachments']>;
  error?: boolean;
}

interface NotesState {
  notes: CommandNote[];
  add(note: Omit<CommandNote, 'id'>): void;
  dismiss(id: string): void;
}

/** The newest few notes per channel are kept, for this tab only. */
const KEEP = 3;

export const useCommandNotes = create<NotesState>()((set) => ({
  notes: [],
  add: (note) =>
    set((s) => {
      const mine = [
        ...s.notes.filter((n) => n.channelId === note.channelId),
        { ...note, id: crypto.randomUUID() },
      ];
      return {
        notes: [...s.notes.filter((n) => n.channelId !== note.channelId), ...mine.slice(-KEEP)],
      };
    }),
  dismiss: (id) => set((s) => ({ notes: s.notes.filter((n) => n.id !== id) })),
}));
