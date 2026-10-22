// SPDX-License-Identifier: Apache-2.0
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '../chat/active-workspace';
import { customEmojiQuery, type CustomEmoji } from './richer';

/** The active workspace's custom emoji by name. */
export function useCustomEmoji(): Map<string, CustomEmoji> {
  const ws = useActiveWorkspace().id;
  const list = useQuery(customEmojiQuery(ws)).data;
  return useMemo(() => new Map((list ?? []).map((e) => [e.name, e])), [list]);
}
