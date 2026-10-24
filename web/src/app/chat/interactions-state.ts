// SPDX-License-Identifier: AGPL-3.0-only
import { toast } from 'sonner';
import { create } from 'zustand';
import type { components } from '@cenacle/core/api';

export type BotDialog = components['schemas']['Dialog'];
export type Result = components['schemas']['InteractionResult'];

/** The dialog an app opened for the person (one at a time). */
export const useBotDialog = create<{
  dialog: BotDialog | null;
  open: (d: BotDialog | null) => void;
}>((set) => ({ dialog: null, open: (dialog) => set({ dialog }) }));

/** Shows what an app answered: a note, or a dialog. */
export function showResult(result: Result) {
  if (result.text) toast(result.text);
  if (result.dialog) useBotDialog.getState().open(result.dialog);
}
