// SPDX-License-Identifier: AGPL-3.0-only
import { calls, type Call } from '@cenacle/core';
import { beforeJoining } from './prejoin-state';
import { errorCode, joinCall, useCall } from './state';

/**
 * Starts the call of a channel, or joins (answers) the one going on, after the
 * check of microphone and camera. `nonce` makes a repeated start the same call
 * (`onStarted` says when it is used up).
 */
export function startOrJoinCall(
  channel: { id: string; name: string },
  existing: Call | null,
  selfID: string,
  nonce: string,
  onStarted?: () => void,
): Promise<void> {
  useCall.setState({ error: '' });
  const going = existing && existing.state !== 'ended' ? existing : null;
  return beforeJoining(channel.name, !going, !!going?.recording_on, (media) =>
    (going
      ? going.state === 'ringing' && !going.participants.some((p) => p.user_id === selfID)
        ? calls.answer(going.id, 'accept').then((call) => joinCall(call, media))
        : joinCall(going, media)
      : calls.start(channel.id, nonce).then((call) => {
          onStarted?.();
          return joinCall(call, media);
        })
    ).catch((error) => useCall.setState({ error: errorCode(error) })),
  );
}
