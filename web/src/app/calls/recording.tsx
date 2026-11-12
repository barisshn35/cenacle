// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { CircleIcon, SquareIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { calls } from '@cenacle/core';
import { Button } from '@cenacle/ui/components/button';
import { useProfile } from '../profile/profiles';
import { canRecord, postRecording, startRecording } from './recorder';
import { errorCode, useCall } from './state';

/** Starts recording (one person at a time). */
export function RecordButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('calls');
  const call = useCall((s) => s.call);
  if (!call || call.recording_on || !canRecord()) return null;
  return (
    <Button
      variant="outline"
      disabled={disabled}
      onClick={() =>
        void calls
          .setRecording(call.id, true)
          .catch((error: unknown) => useCall.setState({ error: errorCode(error) }))
      }
    >
      <CircleIcon data-icon="inline-start" className="fill-destructive text-destructive" />
      {t('recording.start')}
    </Button>
  );
}

/**
 * While a call is recorded: everyone sees it, who records, and may stop it;
 * the recorder's app records and posts the file when it stops.
 */
export function RecordingStatus({ selfID }: { selfID: string }) {
  const { t } = useTranslation('calls');
  const call = useCall((s) => s.call);
  const connected = useCall((s) => s.connection === 'connected');
  const by = useProfile(call?.recording_by ?? undefined)?.display_name;
  const on = !!call?.recording_on;
  const mine = on && call?.recording_by === selfID;
  const channelID = call?.channel_id;

  useEffect(() => {
    if (!mine || !connected || !channelID) return;
    const recording = startRecording(selfID);
    if (!recording) return;
    // Stopped (by anyone), the call left or ended: the file goes to the channel.
    return () => void recording.stop().then((blob) => postRecording(channelID, blob));
  }, [mine, connected, channelID, selfID]);

  if (!on || !call) return null;
  return (
    <div
      role="status"
      data-testid="recording"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <span
          aria-hidden
          className="size-2.5 animate-pulse rounded-full bg-destructive motion-reduce:animate-none"
        />
        {mine ? t('recording.byYou') : by ? t('recording.by', { name: by }) : t('recording.on')}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void calls
            .setRecording(call.id, false)
            .catch((error: unknown) => useCall.setState({ error: errorCode(error) }))
        }
      >
        <SquareIcon data-icon="inline-start" />
        {t('recording.stop')}
      </Button>
    </div>
  );
}
