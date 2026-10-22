// SPDX-License-Identifier: Apache-2.0
import type { UseNavigateResult } from '@tanstack/react-router';
import { useLayout } from '../../stores/layout';
import { inChannel, type Message } from '../chat/data';
import { useJump } from '../chat/jump';

/** Goes to a message: in its channel, or in its thread for a reply. */
export function openMessage(navigate: UseNavigateResult<string>, m: Message): void {
  void navigate({ to: '/c/$channelId', params: { channelId: m.channel_id } });
  if (inChannel(m)) {
    useJump.getState().jump({ channelId: m.channel_id, messageId: m.id });
  } else {
    useLayout.getState().openThread({ channelId: m.channel_id, rootId: m.root_id! });
    useJump.getState().done(m.id);
  }
}
