// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';
import {
  CallSession,
  calls,
  type Call,
  type CallConnection,
  type PublicationKind,
  type RemotePublication,
} from '@cenacle/core';
import { ApiError } from '@cenacle/core/api';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { channelsQuery, type Channel } from '../chat/data';
import {
  notificationsQuery,
  notifies,
  soundFor,
  type NotificationSettings,
} from '../notifications/notifications';
import { myProfileQuery, type MyProfile } from '../profile/profiles';
import { playSound } from '../notifications/sounds';
import i18next from 'i18next';

interface State {
  call: Call | null;
  incoming: Call | null;
  session: CallSession | null;
  connection: CallConnection;
  tracks: readonly RemotePublication[];
  local: ReadonlyMap<PublicationKind, MediaStreamTrack>;
  speakers: readonly string[];
  expanded: boolean;
  error: string;
  joining: boolean;
  /** Ring tone repeated while an incoming call rings. */
  ringTone: { id: string; volume: number } | null;
  /** Chosen input devices; used the next time that device is turned on. */
  devices: { audio?: string; camera?: string };
  /** Reactions floating over tiles for a moment (call.reaction). */
  reactions: readonly { key: number; userID: string; emoji: string }[];
}
export const useCall = create<State>()(() => ({
  call: null,
  incoming: null,
  session: null,
  connection: 'closed',
  tracks: [],
  local: new Map(),
  speakers: [],
  expanded: true,
  error: '',
  joining: false,
  ringTone: null,
  devices: {},
  reactions: [],
}));

/** How long a reaction floats over a tile. */
export const REACTION_MS = 3500;
let reactionKey = 0;

/** call.reaction: show it over the sender's tile for a moment. */
export function applyCallReaction(data: unknown): void {
  const d = data as { call_id?: string; user_id?: string; emoji?: string } | null;
  const call = useCall.getState().call;
  if (!d || !call || d.call_id !== call.id || !d.user_id || !d.emoji) return;
  const key = ++reactionKey;
  useCall.setState((s) => ({
    reactions: [...s.reactions.slice(-11), { key, userID: d.user_id!, emoji: d.emoji! }],
  }));
  setTimeout(
    () => useCall.setState((s) => ({ reactions: s.reactions.filter((r) => r.key !== key) })),
    REACTION_MS,
  );
}
// The last live event per channel: a fetch that started before it must not
// overwrite it when it answers later.
const lastEvent = new Map<string, { at: number; call: Call }>();
export const channelCallQuery = (channelID: string) =>
  queryOptions({
    queryKey: ['calls', 'channel', channelID],
    queryFn: async ({ signal }) => {
      const started = performance.now();
      const current = await calls.current(channelID, signal);
      const event = lastEvent.get(channelID);
      return event && event.at > started ? event.call : current;
    },
    enabled: !!channelID,
    staleTime: 10000,
    refetchInterval: 15000,
    retry: false,
  });
export const callSettingsQuery = (workspaceID: string) =>
  queryOptions({
    queryKey: ['calls', 'settings', workspaceID],
    queryFn: () => calls.settings(workspaceID),
    enabled: !!workspaceID,
    staleTime: 30000,
  });
export function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.problem.code;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'capture_denied';
    if (error.name === 'NotFoundError') return 'device_missing';
    if (error.name === 'NotReadableError') return 'device_busy';
  }
  if (error instanceof Error && error.message === 'screen_busy') return 'screen_busy';
  return 'call_failed';
}
/** The message for a call that ended before this person could join it. */
export function endedCode(call: Call): string {
  if (call.end_reason === 'busy') return 'peer_busy';
  if (call.end_reason === 'declined') return 'peer_declined';
  if (call.end_reason === 'missed') return 'call_missed';
  return 'closed';
}
/** Turns on what the person chose to join with, once the call is connected. */
function joinWith(session: CallSession, media: JoinMedia) {
  const wanted = [
    media.audio && (['audio', media.mic] as const),
    media.camera && (['camera', media.cam] as const),
  ].filter(Boolean) as (readonly ['audio' | 'camera', string])[];
  useCall.setState((s) => ({
    devices: { ...s.devices, audio: media.mic || undefined, camera: media.cam || undefined },
  }));
  if (media.speaker) void session.setSpeaker(media.speaker).catch(() => undefined);
  if (!wanted.length) return;
  const start = () => {
    for (const [kind, device] of wanted)
      void session
        .enable(kind, device || undefined)
        .catch((error: unknown) => useCall.setState({ error: errorCode(error) }));
  };
  if (useCall.getState().connection === 'connected') return start();
  const stop = useCall.subscribe((s) => {
    if (s.session !== session) return stop();
    if (s.connection === 'connected') {
      stop();
      start();
    }
  });
  setTimeout(stop, 30_000);
}

/** What to join a call with (the check before joining). */
export interface JoinMedia {
  audio: boolean;
  camera: boolean;
  mic: string;
  cam: string;
  speaker: string;
}

export async function joinCall(call: Call, media?: JoinMedia): Promise<void> {
  if (call.state === 'ended') {
    useCall.setState({ error: endedCode(call) });
    return;
  }
  const state = useCall.getState();
  if (state.joining) return;
  if (state.session && state.call?.id !== call.id) {
    useCall.setState({ error: 'call_busy' });
    return;
  }
  if (state.session) {
    useCall.setState({ expanded: true });
    return;
  }
  const session: CallSession = new CallSession({
    callID: call.id,
    onState: (connection) => {
      if (useCall.getState().session !== session) return;
      useCall.setState({ connection });
    },
    onError: (error) => useCall.setState({ error }),
    onTracks: (tracks) => useCall.setState({ tracks }),
    onLocalTracks: (local) => useCall.setState({ local }),
    onSpeakers: (speakers) => useCall.setState({ speakers }),
  });
  useCall.setState({ call, session, joining: true, expanded: true, error: '', incoming: null });
  try {
    await session.connect();
    if (media) joinWith(session, media);
  } catch (error) {
    session.close();
    useCall.setState({ session: null, error: errorCode(error) });
    // Release an initial reservation promptly; reconnects retain it for 30 seconds.
    void calls.leave(call.id).catch(() => undefined);
  } finally {
    useCall.setState({ joining: false });
  }
}
export async function leaveCall(): Promise<void> {
  const session = useCall.getState().session;
  useCall.setState({
    session: null,
    call: null,
    connection: 'closed',
    tracks: [],
    local: new Map(),
    speakers: [],
  });
  try {
    await session?.leave();
  } catch {
    useCall.setState({ error: 'leave_failed' });
  }
}
/** The call ended elsewhere (declined, unanswered, ended): close it and say why. */
function finish(call: Call): void {
  useCall.getState().session?.close();
  useCall.setState({
    session: null,
    call: null,
    connection: 'closed',
    tracks: [],
    local: new Map(),
    speakers: [],
    error: endedCode(call),
  });
}
export function clearCalls(): void {
  useCall.getState().session?.close();
  useCall.setState({
    call: null,
    incoming: null,
    session: null,
    connection: 'closed',
    tracks: [],
    local: new Map(),
    speakers: [],
    error: '',
  });
}
/** Revision checks fence replayed outbox events. Media authorization is independently rechecked. */
export function applyCallEvent(
  client: QueryClient,
  type: string,
  data: unknown,
  selfID: string,
): boolean {
  if (
    ![
      'call.ringing',
      'call.started',
      'call.joined',
      'call.left',
      'call.ended',
      'call.participants',
    ].includes(type)
  )
    return false;
  if (
    data &&
    typeof data === 'object' &&
    'needs_refresh' in data &&
    data.needs_refresh === true &&
    'id' in data &&
    typeof data.id === 'string'
  ) {
    void calls
      .get(data.id)
      .then((snapshot) => applyCallEvent(client, type, snapshot, selfID))
      .catch(() => undefined);
    return true;
  }
  if (!isCall(data)) return true;
  const call = data;
  const key = channelCallQuery(call.channel_id).queryKey;
  const previous = client.getQueryData<Call | null>(key);
  if (
    previous &&
    (previous.id === call.id
      ? previous.revision >= call.revision
      : previous.created_at > call.created_at)
  )
    return true;
  client.setQueryData(key, call);
  lastEvent.set(call.channel_id, { at: performance.now(), call });
  const active = useCall.getState();
  if (active.call?.id === call.id) {
    if (call.state === 'ended') finish(call);
    else useCall.setState({ call });
  }
  if (active.incoming?.id === call.id && call.state !== 'ringing')
    useCall.setState({ incoming: null });
  if (
    type === 'call.ringing' &&
    call.state === 'ringing' &&
    call.ring_until &&
    Date.parse(call.ring_until) > Date.now() &&
    !call.participants.some((p) => p.user_id === selfID) &&
    !active.session
  )
    void ring(client, call);
  return true;
}
/** Shows an incoming direct call, honouring pause, mute and quiet hours. */
async function ring(client: QueryClient, call: Call): Promise<void> {
  const find = (list?: Channel[]) => list?.find((c) => c.id === call.channel_id);
  // A conversation started a moment ago may not be in the list yet.
  const channel =
    find(client.getQueryData<Channel[]>(channelsQuery.queryKey)) ??
    find(await client.fetchQuery({ ...channelsQuery, staleTime: 0 }).catch(() => undefined));
  if (channel?.kind !== 'direct') return;
  let settings: NotificationSettings;
  let profile: MyProfile | undefined;
  try {
    // A call may arrive before the settings were first loaded; never skip it for that.
    settings = await client.ensureQueryData(notificationsQuery);
    profile = await client.ensureQueryData(myProfileQuery).catch(() => undefined);
  } catch {
    return;
  }
  const now = useCall.getState();
  if (
    !call.ring_until ||
    Date.parse(call.ring_until) <= Date.now() ||
    now.session ||
    now.incoming?.id === call.id
  )
    return;
  // A later event may have ended the call while the settings loaded.
  const latest = client.getQueryData<Call | null>(channelCallQuery(call.channel_id).queryKey);
  if (latest?.id === call.id && latest.state !== 'ringing') return;
  if (!notifies(settings, channel, 'direct', profile?.timezone ?? '')) return;
  useCall.setState({
    incoming: call,
    ringTone: { id: soundFor(settings, channel.id, 'direct'), volume: settings.prefs.volume },
  });
  if (
    settings.prefs.desktop &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted' &&
    document.visibilityState !== 'visible'
  ) {
    const notice = new Notification('Cenacle', {
      body: i18next.t('calls:incoming'),
      tag: `call-${call.id}`,
      silent: true,
    });
    notice.onclick = () => {
      if (useCall.getState().incoming?.id === call.id) window.focus();
      notice.close();
    };
    setTimeout(() => notice.close(), Math.max(0, Date.parse(call.ring_until) - Date.now()));
  }
}
/** Plays the ring tone now and every few seconds while the call still rings. */
export function startRinging(): () => void {
  const play = () => {
    const tone = useCall.getState().ringTone;
    if (tone) playSound(tone.id, tone.volume);
  };
  play();
  const timer = setInterval(play, 4000);
  return () => clearInterval(timer);
}
export async function resyncCalls(client: QueryClient): Promise<void> {
  useCall.setState({ incoming: null }); // Never ring from a replay/snapshot.
  await client.invalidateQueries({ queryKey: ['calls'] });
  const active = useCall.getState();
  if (!active.call || !active.session) return;
  try {
    const call = await calls.get(active.call.id);
    if (useCall.getState().call?.id !== call.id) return;
    if (call.state === 'ended') finish(call);
    else useCall.setState({ call });
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) clearCalls();
  }
}
function isCall(data: unknown): data is Call {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<Call>;
  return (
    typeof value.id === 'string' &&
    typeof value.channel_id === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.created_at === 'string' &&
    ['ringing', 'active', 'ended'].includes(value.state ?? '') &&
    Array.isArray(value.participants)
  );
}
