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
import { ApiError, apiFetch } from '@cenacle/core/api';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { channelsQuery, type Channel } from '../chat/data';
import {
  notificationsQuery,
  notifies,
  soundFor,
  type NotificationSettings,
} from '../notifications/notifications';
import { loadProfile, myProfileQuery } from '../profile/profiles';
import { inFront, systemNotification } from '../notifications/notifier';
import { toast } from 'sonner';
import { beforeJoining } from './prejoin-state';
import { processTrack } from './effects';
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
// Calls already rung or told about (events of one call come several times).
const announced = new Set<string>();
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
/** The calls going on in one's channels of a workspace (the sidebar's marks). */
export const activeCallsQuery = (workspaceID: string) =>
  queryOptions({
    queryKey: ['calls', 'active', workspaceID],
    queryFn: ({ signal }) =>
      apiFetch<{ calls: Call[] }>(`/api/workspaces/${workspaceID}/calls`, { signal }).then(
        (r) => r.calls,
      ),
    enabled: !!workspaceID,
    staleTime: 60_000,
  });

/** Keeps the sidebar's marks in step with a call's latest state. */
function noteActive(client: QueryClient, call: Call) {
  for (const [key, list] of client.getQueriesData<Call[]>({ queryKey: ['calls', 'active'] })) {
    if (!list) continue;
    const rest = list.filter((c) => c.channel_id !== call.channel_id || c.id !== call.id);
    client.setQueryData(key, call.state === 'ended' ? rest : [call, ...rest]);
  }
  // A list still loading may predate the call: the server's answer settles it.
  void client.invalidateQueries({ queryKey: ['calls', 'active'] });
}

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
    process: processTrack,
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
  noteActive(client, call);
  lastEvent.set(call.channel_id, { at: performance.now(), call });
  const active = useCall.getState();
  if (active.call?.id === call.id) {
    if (call.state === 'ended') finish(call);
    else useCall.setState({ call });
  }
  if (active.incoming?.id === call.id && call.state !== 'ringing')
    useCall.setState({ incoming: null });
  const mine = call.participants.some((p) => p.user_id === selfID);
  if (
    type === 'call.ringing' &&
    call.state === 'ringing' &&
    call.ring_until &&
    Date.parse(call.ring_until) > Date.now() &&
    !mine &&
    !active.session
  )
    void ring(client, call, selfID);
  // A call that just started without ringing: a group conversation rings, a channel tells.
  const fresh =
    call.state === 'active' &&
    (!previous || previous.id !== call.id || previous.state === 'ended') &&
    Date.now() - Date.parse(call.created_at) < GROUP_RING_MS &&
    !mine &&
    !active.session;
  if (fresh && !announced.has(call.id)) {
    announced.add(call.id);
    void ring(client, call, selfID).then(() => {
      if (useCall.getState().incoming?.id !== call.id) void announce(client, call, selfID);
    });
  }
  return true;
}
/** How long a group call rings (direct calls ring until the server's ring_until). */
const GROUP_RING_MS = 30_000;

/** The person who started a call (its first participant other than oneself). */
async function callerName(call: Call, selfID: string): Promise<string> {
  const id = call.participants.find((p) => p.user_id && p.user_id !== selfID)?.user_id;
  const profile = id ? await loadProfile(id).catch(() => null) : null;
  return profile?.display_name ?? '';
}

async function callContext(client: QueryClient, call: Call) {
  const find = (list?: Channel[]) => list?.find((c) => c.id === call.channel_id);
  // A conversation started a moment ago may not be in the list yet.
  const channel =
    find(client.getQueryData<Channel[]>(channelsQuery.queryKey)) ??
    find(await client.fetchQuery({ ...channelsQuery, staleTime: 0 }).catch(() => undefined));
  try {
    // A call may arrive before the settings were first loaded; never skip it for that.
    const settings = await client.ensureQueryData(notificationsQuery);
    const profile = await client.ensureQueryData(myProfileQuery).catch(() => undefined);
    return { channel, settings, timeZone: profile?.timezone ?? '' };
  } catch {
    return { channel, settings: undefined, timeZone: '' };
  }
}

/** The ring tone: the calls' own, else the conversation's direct-message sound. */
const ringToneOf = (settings: NotificationSettings, channelId: string) =>
  settings.prefs.calls?.sound ?? soundFor(settings, channelId, 'direct');

/**
 * Rings for an incoming direct or group call, honouring the person's call
 * settings, pause, mute and quiet hours; outside the app's window (or with it
 * behind others) the system notification says so too.
 */
async function ring(client: QueryClient, call: Call, selfID: string): Promise<void> {
  const { channel, settings, timeZone } = await callContext(client, call);
  if (!channel || !settings || (channel.kind !== 'direct' && channel.kind !== 'group')) return;
  if (settings.prefs.calls && !settings.prefs.calls.ring) return;
  // A group call has no ring time on the server: it rings here for a while.
  const until =
    call.ring_until ?? new Date(Date.parse(call.created_at) + GROUP_RING_MS).toISOString();
  const now = useCall.getState();
  if (Date.parse(until) <= Date.now() || now.session || now.incoming?.id === call.id) return;
  // A later event may have ended the call while the settings loaded.
  const latest = client.getQueryData<Call | null>(channelCallQuery(call.channel_id).queryKey);
  if (latest?.id === call.id && latest.state === 'ended') return;
  if (channel.kind === 'direct' && latest?.id === call.id && latest.state !== 'ringing') return;
  if (!notifies(settings, channel, 'direct', timeZone)) return;
  useCall.setState({
    incoming: { ...call, ring_until: until },
    ringTone: { id: ringToneOf(settings, channel.id), volume: settings.prefs.volume },
  });
  if (settings.prefs.desktop && !inFront()) {
    const who = await callerName(call, selfID);
    systemNotification(
      {
        title: channel.kind === 'group' ? `${who} · ${channel.name}` : who || 'Cenacle',
        body: i18next.t('calls:incoming'),
        tag: `call-${call.id}`,
        channelId: channel.id,
        sticky: true,
      },
      () => window.focus(),
    );
  }
}

/**
 * A call started in a channel: a toast with "Join" (and the system
 * notification when the app is behind), as the channel notifies the person,
 * unless they turned this off.
 */
async function announce(client: QueryClient, call: Call, selfID: string): Promise<void> {
  const { channel, settings, timeZone } = await callContext(client, call);
  if (!channel || !settings || channel.kind === 'direct' || channel.kind === 'group') return;
  if (settings.prefs.calls && !settings.prefs.calls.channel) return;
  if (!notifies(settings, channel, 'message', timeZone)) return;
  if (useCall.getState().session) return;
  const who = await callerName(call, selfID);
  const text = who
    ? i18next.t('calls:startedIn', { name: who, channel: channel.name })
    : i18next.t('calls:startedInSomeone', { channel: channel.name });
  playSound(ringToneOf(settings, channel.id), settings.prefs.volume);
  toast(text, {
    id: `call-${call.id}`,
    duration: 15_000,
    action: {
      label: i18next.t('calls:join'),
      onClick: () =>
        void beforeJoining(channel.name, false, (media) =>
          joinCall(call, media).catch((error) => useCall.setState({ error: errorCode(error) })),
        ),
    },
  });
  if (settings.prefs.desktop && !inFront())
    systemNotification(
      { title: channel.name, body: text, tag: `call-${call.id}`, channelId: channel.id },
      () => window.focus(),
    );
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

/** A changed effect applies at once to what is being sent (it is captured again). */
export function reapply(kind: 'audio' | 'camera'): void {
  const { session, local, devices } = useCall.getState();
  if (!session || !local.has(kind)) return;
  void session
    .disable(kind)
    .then(() => session.enable(kind, devices[kind]))
    .catch((error: unknown) => useCall.setState({ error: errorCode(error) }));
}
