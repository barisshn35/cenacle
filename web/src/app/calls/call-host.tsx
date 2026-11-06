// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { calls, type PublicationKind, type RemotePublication } from '@cenacle/core';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import {
  MicIcon,
  MicOffIcon,
  VideoIcon,
  VideoOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
  PhoneOffIcon,
  Minimize2Icon,
  PhoneIcon,
} from 'lucide-react';
import { cn } from '@cenacle/ui/lib/utils';
import { toast } from 'sonner';
import { useSession } from '../auth/session';
import { useProfile } from '../profile/profiles';
import { channelsQuery } from '../chat/data';
import { errorCode, joinCall, leaveCall, startRinging, useCall } from './state';

/** Call shortcuts: Ctrl/Cmd+Shift with these keys (listed in the shortcuts dialog). */
const callShortcuts = { KeyM: 'audio', KeyO: 'camera', KeyE: 'screen', KeyH: 'leave' } as const;

/** Turns a device on with the chosen input, or off. */
function toggle(kind: PublicationKind): Promise<void> | undefined {
  const current = useCall.getState();
  if (!current.session) return undefined;
  if (current.local.has(kind)) return current.session.disable(kind);
  return current.session.enable(kind, kind === 'screen' ? undefined : current.devices[kind]);
}

export function CallHost() {
  const { t } = useTranslation('calls');
  const state = useCall();
  const channels = useQuery(channelsQuery).data;
  const selfID = useSession().user.id;
  const channelName = channels?.find((c) => c.id === state.call?.channel_id)?.name ?? t('title');
  useEffect(() => {
    if (!state.incoming?.ring_until) return;
    const timer = setTimeout(
      () => useCall.setState({ incoming: null }),
      Math.max(0, Date.parse(state.incoming.ring_until) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [state.incoming]);
  useEffect(() => (state.incoming ? startRinging() : undefined), [state.incoming]);
  useEffect(() => {
    const leave = () => useCall.getState().session?.close();
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || !event.shiftKey || !(event.ctrlKey || event.metaKey))
        return;
      const current = useCall.getState();
      const action = callShortcuts[event.code as keyof typeof callShortcuts];
      if (!current.session || !action) return;
      event.preventDefault();
      if (action === 'leave') {
        void leaveCall();
        return;
      }
      if (current.connection !== 'connected') return;
      void toggle(action)?.catch((error) => useCall.setState({ error: errorCode(error) }));
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const report = (error: unknown) => useCall.setState({ error: errorCode(error) });
  // The caller of a direct call waits for an answer while it rings.
  const status =
    state.call?.state === 'ringing' && state.connection === 'connected'
      ? 'ringing'
      : state.connection;
  const incomingName =
    channels?.find((c) => c.id === state.incoming?.channel_id)?.name ?? t('incoming');
  useEffect(() => {
    if (!state.error || state.call) return;
    const text = t(state.error, { defaultValue: t('error') });
    // How a call ended is news, not a failure.
    if (['closed', 'peer_declined', 'call_missed'].includes(state.error)) toast(text);
    else toast.error(text);
  }, [state.error, state.call, t]);
  return (
    <>
      {state.tracks
        .filter((track) => track.kind === 'audio')
        .map((audio) => (
          <MediaTile
            key={audio.track_id}
            track={audio.track}
            trackID={audio.track_id}
            audio
            label={t('title')}
          />
        ))}
      <Dialog
        open={!!state.incoming}
        onOpenChange={(open) => {
          if (!open) useCall.setState({ incoming: null });
        }}
      >
        <DialogContent>
          <DialogTitle>{t('incoming')}</DialogTitle>
          <DialogDescription>{incomingName}</DialogDescription>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const call = state.incoming;
                useCall.setState({ incoming: null });
                if (call) void calls.answer(call.id, 'decline').catch(report);
              }}
            >
              {t('decline')}
            </Button>
            <Button
              onClick={() => {
                const call = state.incoming;
                useCall.setState({ incoming: null });
                if (call) void calls.answer(call.id, 'accept').then(joinCall).catch(report);
              }}
            >
              {t('accept')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {state.call && !state.expanded && (
        <div className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-xl border bg-popover p-3 text-popover-foreground">
          <Button variant="ghost" onClick={() => useCall.setState({ expanded: true })}>
            <PhoneIcon data-icon="inline-start" />
            {channelName} · {t(status)}
          </Button>
          <Button variant="destructive" onClick={() => void leaveCall()} aria-label={t('leave')}>
            <PhoneOffIcon />
          </Button>
        </div>
      )}
      <Dialog
        open={!!state.call && state.expanded}
        onOpenChange={(expanded) => useCall.setState({ expanded })}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl"
          showCloseButton={false}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="truncate">{channelName}</DialogTitle>
              <DialogDescription aria-live="polite">{t(status)}</DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('minimize')}
              onClick={() => useCall.setState({ expanded: false })}
            >
              <Minimize2Icon />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('noRecording')}</p>
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            aria-label={t('participants', {
              count: state.call?.participants.filter((p) => p.state !== 'left').length ?? 0,
            })}
          >
            {state.call?.participants
              .filter((p) => p.state !== 'left')
              .map((person) => {
                const tracks = state.tracks.filter((track) => track.participant_id === person.id);
                const own = person.user_id === selfID;
                return (
                  <Participant
                    key={person.id}
                    userID={person.user_id ?? ''}
                    own={own}
                    speaking={state.speakers.includes(person.user_id ?? '')}
                    tracks={tracks}
                    local={own ? state.local : undefined}
                  />
                );
              })}
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {t(state.error, { defaultValue: t('error') })}
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            {(['audio', 'camera', 'screen'] as const).map((kind) => {
              const active = state.local.has(kind);
              const Icon =
                kind === 'audio'
                  ? active
                    ? MicIcon
                    : MicOffIcon
                  : kind === 'camera'
                    ? active
                      ? VideoIcon
                      : VideoOffIcon
                    : active
                      ? ScreenShareOffIcon
                      : ScreenShareIcon;
              return (
                <Button
                  key={kind}
                  variant="outline"
                  aria-pressed={active}
                  disabled={!state.session || state.connection !== 'connected'}
                  onClick={() => {
                    useCall.setState({ error: '' });
                    void toggle(kind)?.catch(report);
                  }}
                >
                  <Icon data-icon="inline-start" />
                  {t(kind === 'screen' && active ? 'stopScreen' : kind)}
                </Button>
              );
            })}
            <Button variant="destructive" onClick={() => void leaveCall()}>
              <PhoneOffIcon data-icon="inline-start" />
              {t('leave')}
            </Button>
          </div>
          {!state.local.size && state.session && (
            <p className="text-center text-sm text-muted-foreground">{t('listenOnly')}</p>
          )}
          {state.session && <Devices />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Participant({
  userID,
  own,
  speaking,
  tracks,
  local,
}: {
  userID: string;
  own: boolean;
  speaking: boolean;
  tracks: readonly RemotePublication[];
  local?: ReadonlyMap<PublicationKind, MediaStreamTrack>;
}) {
  const { t } = useTranslation('calls');
  const profile = useProfile(userID || undefined);
  const name = own ? t('you') : (profile?.display_name ?? t('participant'));
  const videos = own
    ? [...(local ?? [])]
        .filter(([kind]) => kind !== 'audio')
        .map(([kind, track]) => ({ track_id: `local-${kind}`, kind, track }))
    : tracks.filter((track) => track.kind !== 'audio');
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-xl border bg-muted p-3',
        speaking && 'border-accent-brand',
      )}
      aria-label={name}
    >
      {videos.length ? (
        videos.map((video) => (
          <MediaTile
            key={video.track_id}
            track={video.track}
            trackID={video.track_id}
            muted={own}
            label={`${name} · ${t(video.kind === 'screen' ? 'screenLabel' : 'camera')}`}
          />
        ))
      ) : (
        <div
          className="flex aspect-video items-center justify-center overflow-hidden bg-background text-2xl font-medium"
          aria-hidden="true"
        >
          {name.slice(0, 2)}
        </div>
      )}
      <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
        <span className="truncate">{name}</span>
        {speaking && <span className="shrink-0 text-muted-foreground">{t('speaking')}</span>}
      </div>
    </section>
  );
}
function MediaTile({
  track,
  trackID,
  muted = false,
  audio = false,
  label,
}: {
  track?: MediaStreamTrack;
  trackID: string;
  muted?: boolean;
  audio?: boolean;
  label: string;
}) {
  const { t } = useTranslation('calls');
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !track) return;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => setBlocked(true));
    let unregister: (() => void) | undefined;
    let cancelled = false;
    if (audio)
      void useCall
        .getState()
        .session?.registerAudio(element)
        .then((remove) => {
          if (cancelled) remove();
          else unregister = remove;
        })
        .catch(() => useCall.setState({ error: 'call_speaker_unsupported' }));
    return () => {
      cancelled = true;
      unregister?.();
      element.pause();
      element.srcObject = null;
    };
  }, [track, audio]);
  useEffect(() => {
    const element = ref.current;
    if (!element || audio || muted) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      useCall
        .getState()
        .session?.tile(
          trackID,
          rect.width,
          rect.height,
          document.visibilityState === 'visible' && rect.width > 0 && rect.height > 0,
        );
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      resize.disconnect();
      useCall.getState().session?.tile(trackID, 0, 0, false);
      document.removeEventListener('visibilitychange', update);
    };
  }, [trackID, audio, muted]);
  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Live WebRTC has no transcription or recorded caption asset. */}
      <video
        ref={ref}
        muted={muted}
        autoPlay
        playsInline
        aria-label={label}
        className={audio ? 'hidden' : 'aspect-video w-full rounded-lg bg-background object-contain'}
      />
      {blocked && (
        <Button
          variant="outline"
          onClick={() => {
            void ref.current?.play().then(() => setBlocked(false));
          }}
        >
          {t('playback')}
        </Button>
      )}
    </>
  );
}

function Devices() {
  const { t } = useTranslation('calls');
  const session = useCall((s) => s.session);
  const chosen = useCall((s) => s.devices);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const previewRef = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const update = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((value) => {
          if (mounted.current) setDevices(value);
        })
        .catch(() => undefined);
    };
    update();
    navigator.mediaDevices.addEventListener('devicechange', update);
    return () => {
      mounted.current = false;
      navigator.mediaDevices.removeEventListener('devicechange', update);
      previewRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => {
    if (video.current) video.current.srcObject = preview;
  }, [preview]);
  const stop = () => {
    previewRef.current?.getTracks().forEach((track) => track.stop());
    previewRef.current = null;
    setPreview(null);
  };
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="min-h-11 cursor-pointer py-2">{t('devices')}</summary>
      <div className="flex flex-col gap-3">
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="sr-only">{t('devices')}</legend>
          {(['audioinput', 'videoinput', 'audiooutput'] as const).map((kind) => (
            <label key={kind} className="flex min-w-0 flex-col gap-1">
              {t(kind === 'audioinput' ? 'audio' : kind === 'videoinput' ? 'camera' : 'speaker')}
              <select
                className="min-h-11 min-w-0 rounded-md border bg-background px-2 text-foreground"
                defaultValue={
                  kind === 'audioinput'
                    ? (chosen.audio ?? '')
                    : kind === 'videoinput'
                      ? (chosen.camera ?? '')
                      : ''
                }
                disabled={kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype)}
                onChange={(event) => {
                  const id = event.target.value || undefined;
                  if (kind === 'audiooutput') {
                    void session
                      ?.setSpeaker(event.target.value)
                      .catch((error) => useCall.setState({ error: errorCode(error) }));
                    return;
                  }
                  const publication = kind === 'audioinput' ? 'audio' : 'camera';
                  useCall.setState((s) => ({ devices: { ...s.devices, [publication]: id } }));
                  // A device that is off stays off; the choice applies when it is turned on.
                  if (!useCall.getState().local.has(publication)) return;
                  void session
                    ?.disable(publication)
                    .then(() => session.enable(publication, id))
                    .catch((error) => useCall.setState({ error: errorCode(error) }));
                }}
              >
                <option value="">{t('defaultDevice')}</option>
                {devices
                  .filter(
                    (device) =>
                      device.kind === kind && device.deviceId && device.deviceId !== 'default',
                  )
                  .map((device, index) => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.label ||
                        `${t(kind === 'videoinput' ? 'camera' : kind === 'audioinput' ? 'audio' : 'speaker')} ${index + 1}`}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </fieldset>
        <Button
          variant="outline"
          disabled={previewPending}
          onClick={() => {
            if (preview) {
              stop();
              return;
            }
            setPreviewPending(true);
            // The chosen devices; a missing camera or microphone does not block the other.
            const id = (value?: string) => (value ? { deviceId: { exact: value } } : true);
            const capture = (constraints: MediaStreamConstraints) =>
              navigator.mediaDevices.getUserMedia(constraints).then(
                (stream) => stream.getTracks(),
                (error: unknown) => {
                  failure = error;
                  return [] as MediaStreamTrack[];
                },
              );
            let failure: unknown;
            void Promise.all([
              capture({ audio: id(chosen.audio), video: false }),
              capture({ audio: false, video: id(chosen.camera) }),
            ])
              .then((parts) => {
                const tracks = parts.flat();
                if (!tracks.length) throw failure;
                return new MediaStream(tracks);
              })
              .then((stream) => {
                if (!mounted.current) {
                  stream.getTracks().forEach((track) => track.stop());
                  return;
                }
                previewRef.current = stream;
                setPreview(stream);
                void navigator.mediaDevices.enumerateDevices().then((value) => {
                  if (mounted.current) setDevices(value);
                });
              })
              .catch((error) => useCall.setState({ error: errorCode(error) }))
              .finally(() => {
                if (mounted.current) setPreviewPending(false);
              });
          }}
        >
          {t(preview ? 'previewStop' : 'previewStart')}
        </Button>
        {preview && (
          <video
            ref={video}
            autoPlay
            muted
            playsInline
            className="mx-auto aspect-video w-full max-w-xs rounded-lg bg-muted"
            aria-label={t('preview')}
          />
        )}
      </div>
    </details>
  );
}
