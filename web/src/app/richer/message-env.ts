// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';
import type { CustomEmoji } from './richer';
import type { Workspace } from '../chat/workspaces';

/**
 * What every message of the workspace in view needs to know: the reader's
 * role (for @admins/@owners) and the workspace's custom emoji. Worked out
 * once for the app (MessageEnvProvider), so message rows only read it.
 */
export interface MessageEnv {
  role: Workspace['role'] | undefined;
  emoji: Map<string, CustomEmoji>;
}

export const MessageEnvContext = createContext<MessageEnv>({ role: undefined, emoji: new Map() });

export const useMessageEnv = () => useContext(MessageEnvContext);
