// SPDX-License-Identifier: AGPL-3.0-only
import { useMessageEnv } from './message-env';
import type { CustomEmoji } from './richer';

/** The custom emoji of the workspace in view, by name. */
export function useCustomEmoji(): Map<string, CustomEmoji> {
  return useMessageEnv().emoji;
}
