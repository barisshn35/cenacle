// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryClient } from '@tanstack/react-query';
import { channelCallQuery } from '../calls/state';
import { startOrJoinCall } from '../calls/start';

/** Starts or joins the call of a meeting's channel (after the check before joining). */
export async function joinMeeting(
  queryClient: QueryClient,
  channelId: string,
  title: string,
  selfId: string,
): Promise<void> {
  const existing = await queryClient.fetchQuery(channelCallQuery(channelId)).catch(() => null);
  await startOrJoinCall({ id: channelId, name: title }, existing, selfId, crypto.randomUUID());
}
