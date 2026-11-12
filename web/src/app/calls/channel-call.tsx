// SPDX-License-Identifier: AGPL-3.0-only
import { beforeJoining } from './prejoin-state';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhoneIcon } from 'lucide-react';
import { toast } from 'sonner';
import { calls, type CallSettings } from '@cenacle/core';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import type { Channel } from '../chat/data';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import { callSettingsQuery, channelCallQuery, errorCode, joinCall, useCall } from './state';

/** Added to the channel header last; no composer or navigation behavior changes. */
export function CallAction({ channel }: { channel: Channel }) {
  const { t } = useTranslation('calls');
  const settings = useQuery(callSettingsQuery(channel.workspace_id));
  const { workspace } = useActiveWorkspace();
  const [pending, setPending] = useState(false);
  const nonce = useRef<string | null>(null);
  const selfID = useSession().user.id;
  const current = useQuery({
    ...channelCallQuery(channel.id),
    // Not before the settings are known: undefined would mean "on".
    enabled:
      !!settings.data?.available &&
      settings.data.enabled &&
      !channel.archived &&
      !channel.encrypted &&
      !channel.mls,
  });
  if (!settings.data?.available || channel.archived) return null;
  const encrypted = channel.encrypted || channel.mls;
  const start = () => {
    useCall.setState({ error: '' });
    setPending(true);
    nonce.current ??= crypto.randomUUID();
    const existing = current.data && current.data.state !== 'ended' ? current.data : null;
    // Starting or joining goes through the check of microphone and camera first.
    void beforeJoining(channel.name, !existing, (media) =>
      (existing
        ? existing.state === 'ringing' && !existing.participants.some((p) => p.user_id === selfID)
          ? calls.answer(existing.id, 'accept').then((call) => joinCall(call, media))
          : joinCall(existing, media)
        : calls.start(channel.id, nonce.current!).then((call) => {
            nonce.current = null;
            return joinCall(call, media);
          })
      ).catch((error) => useCall.setState({ error: errorCode(error) })),
    ).finally(() => setPending(false));
  };
  return (
    <>
      {settings.data.enabled && !encrypted && (
        <Button
          variant="ghost"
          size="icon"
          disabled={
            pending ||
            (!channel.can_post && !current.data) ||
            (workspace?.role === 'guest' && !settings.data.guest_start && !current.data)
          }
          aria-label={t(current.data && current.data.state !== 'ended' ? 'join' : 'start')}
          onClick={start}
        >
          <PhoneIcon />
        </Button>
      )}
    </>
  );
}
export function ChannelCallBar({ channel }: { channel: Channel }) {
  const { t } = useTranslation('calls');
  const selfID = useSession().user.id;
  const settings = useQuery(callSettingsQuery(channel.workspace_id));
  const current = useQuery({
    ...channelCallQuery(channel.id),
    enabled:
      !!settings.data?.available &&
      settings.data.enabled &&
      !channel.archived &&
      !channel.encrypted &&
      !channel.mls,
  });
  const [pending, setPending] = useState(false);
  if (!settings.data?.enabled || !settings.data.available || channel.archived) return null;
  if (channel.encrypted || channel.mls)
    return <p className="border-b px-4 py-2 text-sm text-muted-foreground">{t('encrypted')}</p>;
  const call = current.data;
  if (!call || call.state === 'ended') return null;
  const answer = call.state === 'ringing' && !call.participants.some((p) => p.user_id === selfID);
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-sm"
      role="region"
      aria-label={t('active')}
    >
      <span>
        {t('active')} ·{' '}
        {t('participants', { count: call.participants.filter((p) => p.state !== 'left').length })}
      </span>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void beforeJoining(channel.name, false, (media) =>
            (answer
              ? calls.answer(call.id, 'accept').then((c) => joinCall(c, media))
              : joinCall(call, media)
            ).catch((error) => useCall.setState({ error: errorCode(error) })),
          ).finally(() => setPending(false));
        }}
      >
        {t(answer ? 'accept' : 'join')}
      </Button>
    </div>
  );
}
/** The workspace's call settings (its administrators), in the workspace settings. */
export function WorkspaceCallsSettings({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation('calls');
  const settings = useQuery(callSettingsQuery(workspaceId));
  const [saved, setSaved] = useState(0);
  if (!settings.data) return null;
  return (
    <section className="grid gap-3" data-testid="workspace-calls">
      <p className="text-sm text-muted-foreground">{t('noRecording')}</p>
      <SettingsForm
        key={saved}
        workspaceID={workspaceId}
        initial={settings.data}
        onSaved={() => {
          setSaved((n) => n + 1);
          toast.success(t('saved'));
        }}
      />
    </section>
  );
}

function SettingsForm({
  workspaceID,
  initial,
  onSaved,
}: {
  workspaceID: string;
  initial: CallSettings;
  onSaved: () => void;
}) {
  const { t } = useTranslation('calls');
  const client = useQueryClient();
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(false);
        void calls
          .updateSettings(workspaceID, value)
          .then((settings) => {
            client.setQueryData(callSettingsQuery(workspaceID).queryKey, settings);
            onSaved();
          })
          .catch(() => setError(true))
          .finally(() => setPending(false));
      }}
    >
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
        />
        {t('enable')}
      </label>
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={value.guest_start}
          onChange={(event) => setValue({ ...value, guest_start: event.target.checked })}
        />
        {t('guestStart')}
      </label>
      {initial.captions_available && (
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={!!value.captions}
            onChange={(event) => setValue({ ...value, captions: event.target.checked })}
          />
          <span>
            {t('captions.allow')}
            <span className="block text-xs text-muted-foreground">{t('captions.allowHint')}</span>
          </span>
        </label>
      )}
      {initial.captions_available && value.captions && (
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={!!value.notes}
            onChange={(event) => setValue({ ...value, notes: event.target.checked })}
          />
          <span>
            {t('notes.allow')}
            <span className="block text-xs text-muted-foreground">{t('notes.allowHint')}</span>
          </span>
        </label>
      )}
      <label className="flex flex-col gap-1">
        {t('capacity')}
        <Input
          type="number"
          min={2}
          max={16}
          required
          value={value.max_participants}
          onChange={(event) => setValue({ ...value, max_participants: Number(event.target.value) })}
        />
      </label>
      <label className="flex flex-col gap-1">
        {t('bitrate')}
        <Input
          type="number"
          min={64000}
          max={10000000}
          required
          value={value.max_bitrate}
          onChange={(event) => setValue({ ...value, max_bitrate: Number(event.target.value) })}
        />
      </label>
      {error && (
        <p role="alert" className="text-destructive">
          {t('error')}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {t('save')}
      </Button>
    </form>
  );
}
