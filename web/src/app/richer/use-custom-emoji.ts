// SPDX-License-Identifier: Apache-2.0
import { useMessageEnv } from './message-env';
import type { CustomEmoji } from './richer';

/** The custom emoji of the workspace in view, by name. */
export function useCustomEmoji(): Map<string, CustomEmoji> {
  return useMessageEnv().emoji;
}
