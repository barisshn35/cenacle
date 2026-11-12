// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  ExternalLinkIcon,
  PictureInPicture2Icon,
  HandIcon,
  SmilePlusIcon,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@cenacle/ui/components/popover';
import { cn } from '@cenacle/ui/lib/utils';
import { toast } from 'sonner';
import { useSession } from '../auth/session';
import { Avatar } from '../profile/avatar';
import { useProfile } from '../profile/profiles';
import { channelsQuery } from '../chat/data';
import { errorCode, joinCall, leaveCall, reapply, startRinging, useCall } from './state';
import { PreJoinDialog } from './prejoin';
import { EffectControls } from './effect-controls';
import { CaptionsArea, CaptionsButton } from './captions';
import { useCaptionsAllowed, useNotesAllowed, useRecordingAllowed } from './captions-sender';
import { RecordButton, RecordingStatus } from './recording';
import { NotesButton, NotesStatus } from './notes';
import { loadJoinPrefs } from './prejoin-state';

/** Quick reactions in a call. */
const CALL_REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '😮'];

/** Call shortcuts: Ctrl/Cmd+Shift with these keys (listed in the shortcuts dialog). */
const callShortcuts = { KeyM: 'audio', KeyO: 'camera', KeyE: 'screen', KeyH: 'leave' } as const;

/** The call's keyboard shortcuts, in the app's window and the call's own. */
function shortcut(event: KeyboardEvent) {
  if (event.repeat || event.altKey || !event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
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
}

/** The name of the call's own window (the desktop app recognises it). */
const CALL_WINDOW = 'cenacle-call';

/**
 * Opens a blank window of the same site and moves the page's styles and
 * theme into it, so the call can be drawn there by this page (one session,
 * the same media). Null when the browser refused to open it.
 */
function openCallWindow(title: string): { win: Window; root: HTMLElement } | null {
  const width = Math.min(1280, Math.round(screen.availWidth * 0.8));
  const height = Math.min(820, Math.round(screen.availHeight * 0.8));
  const win = window.open('', CALL_WINDOW, `popup,width=${width},height=${height}`);
  if (!win) return null;
  const doc = win.document;
  doc.title = title;
  doc.head.replaceChildren(
    ...[
      ...document.head.querySelectorAll('style, link[rel="stylesheet"], meta[name="viewport"]'),
    ].map((node) => node.cloneNode(true)),
  );
  for (const { name, value } of document.documentElement.attributes)
    doc.documentElement.setAttribute(name, value);
  doc.body.className = document.body.className;
  const root = doc.createElement('div');
  root.className = 'flex h-dvh flex-col bg-background p-4 text-sm text-foreground';
  doc.body.replaceChildren(root);
  return { win, root };
}

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
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const report = (error: unknown) => useCall.setState({ error: errorCode(error) });
  // The call in a window of its own (drawn by this page into it).
  const [popout, setPopout] = useState<{ win: Window; root: HTMLElement } | null>(null);
  const closePopout = useCallback((back: boolean) => {
    setPopout((current) => {
      current?.win.close();
      return null;
    });
    if (back && useCall.getState().call) useCall.setState({ expanded: true });
  }, []);
  const popOut = () => {
    const opened = openCallWindow(channelName);
    if (!opened) {
      toast.error(t('popupBlocked'));
      return;
    }
    opened.win.addEventListener('keydown', shortcut);
    // A call that ends closes its window.
    const unsubscribe = useCall.subscribe((current) => {
      if (!current.call) opened.win.close();
    });
    // Closing the window brings the call back here; it does not end it.
    opened.win.addEventListener('pagehide', () => {
      unsubscribe();
      setPopout(null);
      if (useCall.getState().call) useCall.setState({ expanded: true });
    });
    setPopout(opened);
    useCall.setState({ expanded: false });
  };
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
      <PreJoinDialog />
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
          {state.incoming?.recording_on && (
            <p role="alert" className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden className="size-2.5 rounded-full bg-destructive" />
              {t('recording.joinNotice')}
            </p>
          )}
          <DialogDescription>{incomingName}</DialogDescription>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const call = state.incoming;
                useCall.setState({ incoming: null });
                // A group call goes on for the others: declining only stops the ringing here.
                if (call?.state === 'ringing') void calls.answer(call.id, 'decline').catch(report);
              }}
            >
              {t('decline')}
            </Button>
            <Button
              onClick={() => {
                const call = state.incoming;
                useCall.setState({ incoming: null });
                // An incoming call is answered at once, with what one joins with by default.
                if (call)
                  void (
                    call.state === 'ringing'
                      ? calls.answer(call.id, 'accept').then((c) => joinCall(c, loadJoinPrefs()))
                      : joinCall(call, loadJoinPrefs())
                  ).catch(report);
              }}
            >
              {t('accept')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {state.call && (!state.expanded || popout) && (
        <div className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-xl border bg-popover p-3 text-popover-foreground">
          <Button
            variant="ghost"
            onClick={() => (popout ? popout.win.focus() : useCall.setState({ expanded: true }))}
          >
            <PhoneIcon data-icon="inline-start" />
            {channelName} · {t(status)}
            {popout && ` · ${t('inOwnWindow')}`}
          </Button>
          <Button variant="destructive" onClick={() => void leaveCall()} aria-label={t('leave')}>
            <PhoneOffIcon />
          </Button>
        </div>
      )}
      {popout &&
        state.call &&
        createPortal(
          <CallPanel
            heading={
              <div className="flex min-w-0 flex-col gap-1">
                <h1 className="truncate text-base font-medium">{channelName}</h1>
                <p aria-live="polite" className="text-muted-foreground">
                  {t(status)}
                </p>
              </div>
            }
            windowAction={
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('popIn')}
                title={t('popIn')}
                onClick={() => closePopout(true)}
              >
                <PictureInPicture2Icon />
              </Button>
            }
            selfID={selfID}
          />,
          popout.root,
        )}
      <Dialog
        open={!!state.call && state.expanded && !popout}
        onOpenChange={(expanded) => useCall.setState({ expanded })}
      >
        <DialogContent
          className="flex h-[calc(100dvh-2rem)] max-h-none flex-col overflow-y-auto sm:max-w-[min(calc(100vw-2rem),1600px)]"
          showCloseButton={false}
        >
          <CallPanel
            heading={
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="truncate">{channelName}</DialogTitle>
                <DialogDescription aria-live="polite">{t(status)}</DialogDescription>
              </div>
            }
            windowAction={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('popOut')}
                  title={t('popOut')}
                  onClick={popOut}
                >
                  <ExternalLinkIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('minimize')}
                  onClick={() => useCall.setState({ expanded: false })}
                >
                  <Minimize2Icon />
                </Button>
              </>
            }
            selfID={selfID}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The call's room: who is in it, their pictures or video, and the controls. */
function CallPanel({
  heading,
  windowAction,
  selfID,
}: {
  heading: ReactNode;
  windowAction: ReactNode;
  selfID: string;
}) {
  const { t } = useTranslation('calls');
  const state = useCall();
  const report = (error: unknown) => useCall.setState({ error: errorCode(error) });
  const people = state.call?.participants.filter((p) => p.state !== 'left') ?? [];
  // Raised hands in the order they went up: the tile shows its place.
  const hands = people
    .filter((p) => p.hand_raised_at)
    .sort((a, b) => a.hand_raised_at!.localeCompare(b.hand_raised_at!))
    .map((p) => p.user_id);
  const handUp = hands.includes(selfID);
  const live = !!state.session && state.connection === 'connected';
  const captionsAllowed = useCaptionsAllowed();
  const notesAllowed = useNotesAllowed();
  const recordingAllowed = useRecordingAllowed();
  const callID = state.call?.id;
  const setHand = (raised: boolean) => {
    if (callID) void calls.setHand(callID, raised).catch(report);
  };
  const react = (emoji: string) => {
    if (callID) void calls.react(callID, emoji).catch(() => undefined);
  };
  // Tiles share the room: one per row for one or two on narrow screens, up to four across.
  const columns =
    people.length <= 1
      ? 'sm:grid-cols-1'
      : people.length <= 4
        ? 'sm:grid-cols-2'
        : people.length <= 9
          ? 'sm:grid-cols-3'
          : 'sm:grid-cols-4';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        {heading}
        <div className="flex shrink-0 gap-1">{windowAction}</div>
      </div>
      <p className="text-sm text-muted-foreground">
        {recordingAllowed ? t('mayRecord') : t('noRecording')}
      </p>
      <div
        className={cn(
          'grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3',
          columns,
          // An odd last tile in two columns sits in the middle, not alone at the left.
          people.length % 2 === 1 &&
            people.length > 1 &&
            people.length <= 4 &&
            'sm:[&>*:last-child]:col-span-2 sm:[&>*:last-child]:mx-auto sm:[&>*:last-child]:w-1/2',
        )}
        aria-label={t('participants', { count: people.length })}
      >
        {people.map((person) => {
          const tracks = state.tracks.filter((track) => track.participant_id === person.id);
          const own = person.user_id === selfID;
          return (
            <Participant
              key={person.id}
              userID={person.user_id ?? ''}
              own={own}
              speaking={state.speakers.includes(person.user_id ?? '')}
              hand={person.user_id ? hands.indexOf(person.user_id) + 1 : 0}
              reactions={state.reactions.filter((r) => r.userID === person.user_id)}
              tracks={tracks}
              local={own ? state.local : undefined}
            />
          );
        })}
      </div>
      <RecordingStatus selfID={selfID} />
      <NotesStatus selfID={selfID} />
      <CaptionsArea selfID={selfID} />
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
        <Button
          variant="outline"
          aria-pressed={handUp}
          disabled={!live}
          onClick={() => setHand(!handUp)}
        >
          <HandIcon data-icon="inline-start" />
          {handUp ? t('lowerHand') : t('raiseHand')}
        </Button>
        {captionsAllowed && <CaptionsButton disabled={!live} />}
        {notesAllowed && <NotesButton disabled={!live} />}
        {recordingAllowed && <RecordButton disabled={!live} />}
        <Popover>
          <PopoverTrigger
            render={
              <Button variant="outline" disabled={!live}>
                <SmilePlusIcon data-icon="inline-start" />
                {t('react')}
              </Button>
            }
          />
          <PopoverContent side="top" className="w-auto p-1">
            <div role="group" aria-label={t('react')} className="flex gap-1">
              {CALL_REACTIONS.map((emoji) => (
                <Button
                  key={emoji}
                  variant="ghost"
                  size="icon"
                  aria-label={t('reactWith', { emoji })}
                  onClick={() => react(emoji)}
                  className="text-xl"
                >
                  {emoji}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button variant="destructive" onClick={() => void leaveCall()}>
          <PhoneOffIcon data-icon="inline-start" />
          {t('leave')}
        </Button>
      </div>
      {state.session && <Devices />}
    </div>
  );
}

function Participant({
  userID,
  own,
  speaking,
  hand = 0,
  reactions = [],
  tracks,
  local,
}: {
  userID: string;
  own: boolean;
  speaking: boolean;
  /** The raised hand's place in the queue (0: not raised). */
  hand?: number;
  reactions?: readonly { key: number; emoji: string }[];
  tracks: readonly RemotePublication[];
  local?: ReadonlyMap<PublicationKind, MediaStreamTrack>;
}) {
  const { t } = useTranslation('calls');
  const profile = useProfile(userID || undefined);
  const name = own ? t('you') : (profile?.display_name ?? t('participant'));
  // The picture (or initials) is of the person, also on one's own tile ("You").
  const self = useSession().user;
  const realName = profile?.display_name ?? (own ? self.display_name : '');
  const videos = own
    ? [...(local ?? [])]
        .filter(([kind]) => kind !== 'audio')
        .map(([kind, track]) => ({ track_id: `local-${kind}`, kind, track }))
    : tracks.filter((track) => track.kind !== 'audio');
  return (
    <section
      className={cn(
        'relative flex min-h-48 min-w-0 flex-col gap-2 rounded-xl border bg-muted p-3',
        speaking && 'border-accent-brand',
      )}
      aria-label={name}
    >
      {/* Reactions float up and fade; they are said once for screen readers. */}
      <div
        aria-live="polite"
        className="pointer-events-none absolute inset-x-0 top-[22%] z-10 flex justify-center"
      >
        {reactions.map((r) => (
          <span key={r.key} className="call-reaction absolute text-4xl">
            {r.emoji}
            <span className="sr-only">{t('reacted', { name, emoji: r.emoji })}</span>
          </span>
        ))}
      </div>
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
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg"
          aria-hidden="true"
        >
          <Avatar name={realName || name} profile={profile} size="lg" />
        </div>
      )}
      <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
        <span className="truncate">{name}</span>
        {hand > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-accent-brand px-2 py-0.5 text-xs font-semibold text-accent-brand-foreground"
            data-testid="raised-hand"
          >
            <HandIcon aria-hidden className="size-3.5" />
            {t('handPlace', { place: hand })}
          </span>
        )}
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
    // The tile may be in the call's own window: watch that window's page.
    const doc = element.ownerDocument;
    const update = () => {
      const rect = element.getBoundingClientRect();
      useCall
        .getState()
        .session?.tile(
          trackID,
          rect.width,
          rect.height,
          doc.visibilityState === 'visible' && rect.width > 0 && rect.height > 0,
        );
    };
    const resize = new (doc.defaultView?.ResizeObserver ?? ResizeObserver)(update);
    resize.observe(element);
    doc.addEventListener('visibilitychange', update);
    update();
    return () => {
      resize.disconnect();
      useCall.getState().session?.tile(trackID, 0, 0, false);
      doc.removeEventListener('visibilitychange', update);
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
        className={
          audio ? 'hidden' : 'min-h-0 w-full flex-1 rounded-lg bg-background object-contain'
        }
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
        <EffectControls onChange={reapply} />
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
