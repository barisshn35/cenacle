// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '../chat/active-workspace';
import { MessageEnvContext } from './message-env';
import { customEmojiQuery } from './richer';

export function MessageEnvProvider({ children }: { children: ReactNode }) {
  const ws = useActiveWorkspace();
  const list = useQuery(customEmojiQuery(ws.id)).data;
  const role = ws.workspace?.role;
  const value = useMemo(
    () => ({ role, emoji: new Map((list ?? []).map((e) => [e.name, e])) }),
    [role, list],
  );
  return <MessageEnvContext value={value}>{children}</MessageEnvContext>;
}
