// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { useSession } from '../auth/session';
import type { Channel, Message } from './data';

/** The message being edited (one at a time). */
export const useEditing = create<{ id: string | null; set: (id: string | null) => void }>()(
  (set) => ({ id: null, set: (id) => set({ id }) }),
);

/** What the current user may do with a message. */
export function useMessagePermissions(m: Message, channel: Channel) {
  const { user } = useSession();
  const own = m.author.id === user.id;
  return {
    edit: own && !channel.archived && !m.burn && !m.sticker,
    remove: own || channel.can_manage,
  };
}
