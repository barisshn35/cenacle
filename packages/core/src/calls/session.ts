// SPDX-License-Identifier: Apache-2.0
import { calls, type CallAdmission } from './api';

export type PublicationKind = 'audio' | 'camera' | 'screen';
export type CallConnection = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export interface RemotePublication {
  track_id: string;
  participant_id: string;
  user_id: string;
  stream_id: string;
  kind: PublicationKind;
  track?: MediaStreamTrack;
}
export interface CallSessionOptions {
  callID: string;
  onState: (state: CallConnection) => void;
  onError: (code: string) => void;
  onTracks: (tracks: readonly RemotePublication[]) => void;
  onSpeakers: (userIDs: readonly string[]) => void;
  onLocalTracks: (tracks: ReadonlyMap<PublicationKind, MediaStreamTrack>) => void;
  /**
   * Turns a captured microphone or camera track into the one sent (noise
   * suppression, background blur); `stop` ends what it started. The captured
   * track is stopped with it.
   */
  process?: (
    kind: 'audio' | 'camera',
    track: MediaStreamTrack,
  ) => Promise<{ track: MediaStreamTrack; stop: () => void }>;
}
interface Frame {
  v: number;
  type: string;
  request_id?: string;
  negotiation_id?: string;
  data: Record<string, unknown>;
}
interface LocalPublication {
  track: MediaStreamTrack;
  logicalID: string;
  transceiver?: RTCRtpTransceiver;
}
interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One instance lives above channel navigation. No token, SDP or ICE is persisted or logged. */
export class CallSession {
  private pc?: RTCPeerConnection;
  private socket?: WebSocket;
  private abort = new AbortController();
  private ended = false;
  private sequence = 0;
  private offerID = '';
  private pendingNegotiation = false;
  private serial: Promise<void> = Promise.resolve();
  private reconnectTask?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private restartWindow = 0;
  private restarts = 0;
  private locals = new Map<PublicationKind, LocalPublication>();
  private remote = new Map<string, RemotePublication>();
  private remoteTracks = new Map<string, MediaStreamTrack>();
  private candidates: RTCIceCandidateInit[] = [];
  private requests = new Map<string, PendingRequest>();
  private capturing = new Set<PublicationKind>();
  private ready = false;
  private maxBitrate = 2500000;
  private bitrateTask: Promise<void> = Promise.resolve();
  private selectedSpeaker = '';
  private audioElements = new Set<HTMLMediaElement>();

  constructor(private readonly options: CallSessionOptions) {}

  async connect(): Promise<void> {
    if (this.ended || this.socket) throw new Error('call_already_open');
    try {
      await this.open();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async open(): Promise<void> {
    const admission = await calls.admit(this.options.callID, this.abort.signal);
    if (this.ended) return;
    const url = signalingURL(admission.signaling_path);
    const pc = new RTCPeerConnection({
      iceServers: ownIceServers(admission),
      bundlePolicy: 'max-bundle',
    });
    const ws = new WebSocket(url);
    this.pc = pc;
    this.socket = ws;
    this.ready = false;
    this.offerID = '';
    this.pendingNegotiation = false;
    this.candidates = [];
    this.remote.clear();
    this.remoteTracks.clear();
    this.options.onTracks([]);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.pc === pc && this.ready && candidateAllowed(candidate.candidate))
        this.send('ice', candidate.toJSON());
    };
    pc.ontrack = ({ track, streams }) => {
      if (this.pc !== pc) return;
      // A reused receiver keeps a local track ID; the SFU's stream ID names the publication.
      const id = streams[0]?.id ?? track.id;
      this.remoteTracks.set(id, track);
      this.syncTracks();
      track.onended = () => {
        if (this.remoteTracks.get(id) === track) this.remoteTracks.delete(id);
        this.syncTracks();
      };
    };
    pc.onnegotiationneeded = () => {
      this.pendingNegotiation = true;
      if (this.ready) this.enqueue(() => this.negotiate(pc));
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.ended) return;
      if (pc.connectionState === 'connected') {
        this.updateSenderLimits();
        clearTimeout(this.connectionTimer);
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        this.options.onState('connected');
      } else if (pc.connectionState === 'failed') {
        this.recover();
      } else if (pc.connectionState === 'disconnected') {
        this.options.onState('reconnecting');
        clearTimeout(this.connectionTimer);
        this.connectionTimer = setTimeout(() => {
          void this.restartICE().catch(() => this.recover());
        }, 5000);
      }
    };
    this.options.onState(this.reconnectTask ? 'reconnecting' : 'connecting');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('call_signaling_timeout'));
        ws.close();
      }, 8000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('call_signaling_unavailable'));
        if (this.ready && this.socket === ws && !this.ended) this.recover();
      };
      ws.onerror = fail;
      ws.onclose = fail;
      ws.onopen = () => {
        if (this.ended) {
          ws.close();
          return;
        }
        // The admission credential appears only in the first encrypted WS frame.
        ws.send(JSON.stringify({ v: 1, type: 'authenticate', data: { token: admission.token } }));
        admission.token = '';
      };
      ws.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (this.socket !== ws || this.ended) return;
        let frame: Frame;
        try {
          frame = parseFrame(data);
        } catch {
          this.fail('call_invalid_signal');
          return;
        }
        if (frame.type === 'authenticated' && !this.ready) {
          clearTimeout(timer);
          this.ready = true;
          resolve();
        } else {
          this.enqueue(() => this.handle(frame, pc));
        }
      };
    });
    if (this.ended || this.pc !== pc) return;
    for (const [kind, local] of this.locals) {
      local.transceiver = undefined;
      if (local.track.readyState !== 'live') continue;
      local.logicalID = local.track.id;
      await this.attach(kind, local, pc);
    }
    // The first client offer opens reception even for a listen-only participant.
    if (pc.getTransceivers().length === 0) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      preferCodecs(pc);
    }
    this.pendingNegotiation = true;
    this.enqueue(() => this.negotiate(pc));
    clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') this.recover();
    }, 10000);
  }

  private enqueue(task: () => Promise<void>): void {
    const transport = this.pc;
    this.serial = this.serial.then(task).catch(() => {
      if (!this.ended && this.pc === transport) this.fail('call_signaling_failed');
    });
  }

  private async negotiate(pc: RTCPeerConnection): Promise<void> {
    if (!this.ready || this.pc !== pc || !this.pendingNegotiation || pc.signalingState !== 'stable')
      return;
    this.pendingNegotiation = false;
    const offer = await pc.createOffer();
    if (this.pc !== pc || this.ended) return;
    await pc.setLocalDescription(offer);
    this.offerID = `c-${++this.sequence}`;
    this.send('offer', { sdp: publicSDP(offer.sdp ?? '') }, undefined, this.offerID);
  }

  private async handle(frame: Frame, pc: RTCPeerConnection): Promise<void> {
    if (this.pc !== pc || this.ended) return;
    const { data } = frame;
    if (frame.request_id) {
      const request = this.requests.get(frame.request_id);
      if (request && (frame.type === 'published' || frame.type === 'error')) {
        clearTimeout(request.timer);
        this.requests.delete(frame.request_id);
        if (frame.type === 'published') {
          this.acceptBitrate(data.max_bitrate);
          request.resolve();
        } else
          request.reject(
            new Error(typeof data.code === 'string' ? data.code : 'call_publish_denied'),
          );
        return;
      }
    }
    switch (frame.type) {
      case 'policy':
        this.acceptBitrate(data.max_bitrate);
        this.updateSenderLimits();
        break;
      case 'offer': {
        if (typeof data.sdp !== 'string' || !frame.negotiation_id) throw new Error('invalid_offer');
        // The browser is always polite. The SFU keeps its outstanding offer.
        if (pc.signalingState !== 'stable') {
          this.pendingNegotiation = true;
          await pc.setLocalDescription({ type: 'rollback' });
        }
        this.offerID = '';
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await this.flushCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send('answer', { sdp: publicSDP(answer.sdp ?? '') }, undefined, frame.negotiation_id);
        await this.negotiate(pc);
        break;
      }
      case 'answer':
        if (frame.negotiation_id !== this.offerID || pc.signalingState !== 'have-local-offer')
          return;
        if (typeof data.sdp !== 'string') throw new Error('invalid_answer');
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        this.offerID = '';
        await this.flushCandidates(pc);
        await this.negotiate(pc);
        break;
      case 'ice': {
        if (typeof data.candidate !== 'string' || data.candidate.length > 2048)
          throw new Error('invalid_candidate');
        const candidate = data as RTCIceCandidateInit;
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else if (this.candidates.length < 64) this.candidates.push(candidate);
        else throw new Error('candidate_limit');
        break;
      }
      case 'track': {
        if (
          typeof data.track_id !== 'string' ||
          typeof data.participant_id !== 'string' ||
          typeof data.user_id !== 'string' ||
          typeof data.stream_id !== 'string' ||
          !['audio', 'camera', 'screen'].includes(String(data.kind))
        )
          throw new Error('invalid_track');
        if (!this.remote.has(data.track_id) && this.remote.size >= 48)
          throw new Error('track_limit');
        this.remote.set(data.track_id, data as unknown as RemotePublication);
        this.syncTracks();
        break;
      }
      case 'track_removed':
        if (typeof data.track_id === 'string') {
          this.remote.delete(data.track_id);
          this.remoteTracks.delete(data.track_id);
          this.syncTracks();
        }
        break;
      case 'speaker':
        if (
          Array.isArray(data.participants) &&
          data.participants.length <= 16 &&
          data.participants.every((v) => typeof v === 'string')
        ) {
          this.options.onSpeakers(data.participants as string[]);
        }
        break;
      case 'error':
        if (data.code === 'negotiation_collision') {
          this.pendingNegotiation = true;
        } else this.options.onError('call_media_error');
        break;
      default:
        break;
    }
  }

  private async flushCandidates(pc: RTCPeerConnection): Promise<void> {
    for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
  }
  private syncTracks(): void {
    this.options.onTracks(
      [...this.remote.values()].map((item) => ({
        ...item,
        track: this.remoteTracks.get(item.track_id),
      })),
    );
  }
  private send(type: string, data: unknown, request_id?: string, negotiation_id?: string): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('call_not_connected');
    if (this.socket.bufferedAmount > 256 * 1024) throw new Error('call_signal_backpressure');
    this.socket.send(JSON.stringify({ v: 1, type, data, request_id, negotiation_id }));
  }
  private publish(kind: PublicationKind, logicalID: string): Promise<void> {
    const requestID = `p-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestID);
        reject(new Error('call_publish_timeout'));
      }, 5000);
      this.requests.set(requestID, { resolve, reject, timer });
      try {
        this.send('publish', { kind, track_id: logicalID }, requestID);
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(requestID);
        reject(error);
      }
    });
  }
  private async attach(
    kind: PublicationKind,
    local: LocalPublication,
    pc: RTCPeerConnection,
  ): Promise<void> {
    await this.publish(kind, local.logicalID);
    if (this.pc !== pc || this.ended) throw new Error('call_closed');
    if (local.transceiver) {
      await local.transceiver.sender.replaceTrack(local.track);
    } else {
      const active = [...this.locals].filter(([, value]) => value.track.readyState === 'live');
      const videos =
        active.filter(([type]) => type !== 'audio').length +
        (kind !== 'audio' && !active.some(([type]) => type === kind) ? 1 : 0);
      const audio = kind === 'audio' || active.some(([type]) => type === 'audio');
      const budget = Math.max(
        3000,
        Math.floor((this.maxBitrate * 0.75 - (audio ? 40000 : 0)) / Math.max(1, videos)),
      );
      local.transceiver = pc.addTransceiver(local.track, {
        direction: 'sendonly',
        streams: [new MediaStream([local.track])],
        sendEncodings:
          kind === 'camera'
            ? [
                {
                  rid: 'q',
                  scaleResolutionDownBy: 4,
                  maxBitrate: Math.floor(budget * 0.1),
                  maxFramerate: 15,
                },
                {
                  rid: 'h',
                  scaleResolutionDownBy: 2,
                  maxBitrate: Math.floor(budget * 0.25),
                  maxFramerate: 30,
                },
                {
                  rid: 'f',
                  scaleResolutionDownBy: 1,
                  maxBitrate: Math.floor(budget * 0.65),
                  maxFramerate: 30,
                },
              ]
            : kind === 'screen'
              ? [{ maxBitrate: budget, maxFramerate: 15 }]
              : [{ maxBitrate: 32000 }],
      });
      preferCodecs(pc);
      if (kind === 'screen') await keepResolution(local.transceiver.sender);
    }
  }

  /** Invoke directly from a user gesture; display capture starts before awaiting admission. */
  async enable(kind: PublicationKind, deviceID?: string): Promise<void> {
    if (this.ended || !this.ready || this.capturing.has(kind)) throw new Error('call_not_ready');
    this.capturing.add(kind);
    let stream: MediaStream | undefined;
    try {
      stream =
        kind === 'screen'
          ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false })
          : await navigator.mediaDevices.getUserMedia(
              kind === 'audio'
                ? {
                    audio: {
                      deviceId: deviceID ? { exact: deviceID } : undefined,
                      echoCancellation: true,
                      noiseSuppression: true,
                      autoGainControl: true,
                    },
                    video: false,
                  }
                : {
                    video: {
                      deviceId: deviceID ? { exact: deviceID } : undefined,
                      width: { ideal: 1280 },
                      height: { ideal: 720 },
                      frameRate: { ideal: 30, max: 30 },
                    },
                    audio: false,
                  },
            );
      const captured = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (!captured || this.ended || !this.pc || !this.ready)
        throw new Error('call_capture_cancelled');
      // What is sent may be the captured track worked on (less noise, a blurred background).
      const worked =
        kind !== 'screen' && this.options.process
          ? await this.options.process(kind, captured).catch(() => null)
          : null;
      const track = worked?.track ?? captured;
      if (worked) {
        const stopWorked = worked.stop;
        const ownStop = track.stop.bind(track);
        // Stopping what is sent also stops the capture and its processing.
        track.stop = () => {
          ownStop();
          stopWorked();
          captured.stop();
        };
        // A camera unplugged ends the capture: what is sent goes too.
        captured.onended = () => {
          if (this.locals.get(kind)?.track === track) void this.disable(kind);
        };
      }
      if (this.ended || !this.pc || !this.ready) {
        track.stop();
        throw new Error('call_capture_cancelled');
      }
      // Shared screens carry text: the encoder keeps detail and lowers the frame rate instead.
      if (kind === 'screen' && 'contentHint' in track) track.contentHint = 'detail';
      const old = this.locals.get(kind);
      const local: LocalPublication = {
        track,
        logicalID: old?.transceiver ? old.logicalID : track.id,
        transceiver: old?.transceiver,
      };
      await this.attach(kind, local, this.pc);
      old?.track.stop();
      this.locals.set(kind, local);
      this.updateSenderLimits();
      track.onended = () => {
        if (this.locals.get(kind)?.track === track) void this.disable(kind);
      };
      this.notifyLocal();
      // Keep only the intended track, including with an over-permissive desktop picker.
      for (const extra of stream.getTracks())
        if (extra !== track && extra !== captured) extra.stop();
      stream = undefined;
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      this.capturing.delete(kind);
    }
  }
  async disable(kind: PublicationKind): Promise<void> {
    const local = this.locals.get(kind);
    if (!local) return;
    local.track.stop();
    try {
      await local.transceiver?.sender.replaceTrack(null);
      if (this.ready) this.send('unpublish', { kind });
    } finally {
      // Retain the logical ID/transceiver for replaceTrack on resume, but release capture.
      this.notifyLocal();
    }
  }
  private notifyLocal(): void {
    this.updateSenderLimits();
    this.options.onLocalTracks(
      new Map(
        [...this.locals]
          .filter(([, value]) => value.track.readyState === 'live')
          .map(([kind, value]) => [kind, value.track]),
      ),
    );
  }
  private acceptBitrate(value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 64000 && value <= 10000000)
      this.maxBitrate = value;
  }
  private updateSenderLimits(): void {
    const pc = this.pc;
    this.bitrateTask = this.bitrateTask
      .then(async () => {
        if (!pc || this.pc !== pc || this.ended) return;
        const active = [...this.locals].filter(([, local]) => local.track.readyState === 'live');
        const videos = active.filter(([kind]) => kind !== 'audio').length;
        const audio = active.some(([kind]) => kind === 'audio');
        const videoBudget = Math.max(
          3000,
          Math.floor((this.maxBitrate * 0.75 - (audio ? 40000 : 0)) / Math.max(1, videos)),
        );
        for (const [kind, local] of active) {
          const sender = local.transceiver?.sender;
          if (!sender) continue;
          const parameters = sender.getParameters();
          if (!parameters.encodings?.length) continue;
          for (const encoding of parameters.encodings) {
            encoding.maxBitrate =
              kind === 'audio'
                ? Math.min(32000, Math.floor(this.maxBitrate * 0.5))
                : Math.floor(
                    videoBudget *
                      (kind === 'camera' && parameters.encodings.length === 3
                        ? encoding.rid === 'q'
                          ? 0.1
                          : encoding.rid === 'h'
                            ? 0.25
                            : 0.65
                        : 1),
                  );
          }
          await sender.setParameters(parameters);
        }
      })
      .catch(() => {
        if (!this.ended && this.pc === pc) this.options.onError('call_bitrate_update_failed');
      });
  }
  tile(trackID: string, width: number, height: number, visible: boolean): void {
    if (this.ready && this.remote.has(trackID))
      this.send('tile', {
        track_id: trackID,
        width: Math.max(0, Math.min(4096, Math.round(width))),
        height: Math.max(0, Math.min(4096, Math.round(height))),
        visible,
      });
  }
  async setSpeaker(deviceID: string): Promise<void> {
    for (const element of this.audioElements) {
      if (!('setSinkId' in element)) throw new Error('call_speaker_unsupported');
      await element.setSinkId(deviceID);
    }
    this.selectedSpeaker = deviceID;
  }
  async registerAudio(element: HTMLMediaElement): Promise<() => void> {
    if (this.selectedSpeaker && 'setSinkId' in element)
      await element.setSinkId(this.selectedSpeaker);
    this.audioElements.add(element);
    return () => {
      this.audioElements.delete(element);
    };
  }

  private recover(): void {
    if (this.ended || this.reconnectTask) return;
    this.beginRecoveryDeadline();
    this.options.onState('reconnecting');
    this.reconnectTask = this.reconnect().finally(() => {
      this.reconnectTask = undefined;
    });
  }
  private beginRecoveryDeadline(): void {
    this.recoveryTimer ??= setTimeout(() => this.fail('call_reconnect_expired'), 30000);
  }
  async restartICE(): Promise<void> {
    if (this.ended || !this.ready || !this.pc) throw new Error('call_not_connected');
    this.beginRecoveryDeadline();
    if (Date.now() - this.restartWindow > 30000) {
      this.restartWindow = Date.now();
      this.restarts = 0;
    }
    if (++this.restarts > 3) {
      this.recover();
      return;
    }
    const pc = this.pc;
    // Refresh TURN credentials before new allocations; the unused admission expires naturally.
    const admission = await calls.admit(this.options.callID, this.abort.signal);
    admission.token = '';
    if (this.pc !== pc || this.ended) return;
    pc.setConfiguration({ ...pc.getConfiguration(), iceServers: ownIceServers(admission) });
    pc.restartIce();
    clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') this.recover();
    }, 5000);
  }
  private async reconnect(): Promise<void> {
    const deadline = Date.now() + 30000;
    this.dropTransport();
    while (!this.ended && Date.now() < deadline) {
      try {
        await this.open();
        return;
      } catch {
        this.dropTransport();
      }
      if (!this.ended)
        await new Promise<void>((resolve) => {
          this.reconnectTimer = setTimeout(resolve, 1500);
          this.abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
    }
    if (!this.ended) this.fail('call_reconnect_expired');
  }
  private dropTransport(): void {
    this.ready = false;
    clearTimeout(this.connectionTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    const pc = this.pc;
    this.pc = undefined;
    pc?.close();
    for (const local of this.locals.values()) local.transceiver = undefined;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('call_transport_closed'));
    }
    this.requests.clear();
    this.remote.clear();
    this.remoteTracks.clear();
    this.options.onTracks([]);
    this.options.onSpeakers([]);
  }
  private fail(code: string): void {
    this.options.onError(code);
    this.close();
  }
  async leave(): Promise<void> {
    if (this.ended) return;
    if (this.ready) {
      try {
        this.send('leave', {});
      } catch {
        /* HTTP leave remains authoritative. */
      }
    }
    this.close();
    await calls.leave(this.options.callID);
  }
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.recoveryTimer);
    this.dropTransport();
    for (const local of this.locals.values()) local.track.stop();
    this.locals.clear();
    this.audioElements.clear();
    this.notifyLocal();
    this.options.onState('closed');
  }
}

export function signalingURL(path: string): string {
  if (path !== '/media/ws') throw new Error('call_invalid_signal_path');
  const url = new URL(path, location.origin);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('call_secure_context_required');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export function ownIceServers(admission: CallAdmission): RTCIceServer[] {
  const servers = admission.ice_servers ?? [];
  if (servers.length > 1) throw new Error('call_invalid_turn');
  return servers.map((server) => {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (
      !urls ||
      urls.length > 2 ||
      !urls.length ||
      urls.some(
        (url) =>
          !/^turn:[^/?#@\s]+:3478\?transport=udp$|^turns:[^/?#@\s]+:5349\?transport=tcp$/.test(url),
      )
    ) {
      throw new Error('call_invalid_turn');
    }
    return { urls, username: server.username, credential: server.credential };
  });
}
function preferCodecs(pc: RTCPeerConnection): void {
  for (const transceiver of pc.getTransceivers()) {
    const kind = transceiver.receiver.track.kind;
    const codecs = RTCRtpReceiver.getCapabilities(kind)?.codecs.filter(
      (codec) => codec.mimeType.toLowerCase() === (kind === 'audio' ? 'audio/opus' : 'video/vp8'),
    );
    if (!codecs?.length) throw new Error('call_codec_unavailable');
    transceiver.setCodecPreferences(codecs);
  }
}
function parseFrame(value: unknown): Frame {
  if (typeof value !== 'string' || value.length > 98304) throw new Error('invalid_frame');
  const frame: unknown = JSON.parse(value);
  if (
    !frame ||
    typeof frame !== 'object' ||
    !('v' in frame) ||
    frame.v !== 1 ||
    !('type' in frame) ||
    typeof frame.type !== 'string' ||
    !('data' in frame) ||
    !frame.data ||
    typeof frame.data !== 'object' ||
    Array.isArray(frame.data)
  )
    throw new Error('invalid_frame');
  return frame as Frame;
}

/** Keep mDNS/loopback/link-local candidates local; the SFU must never resolve hostnames. */
export function candidateAllowed(candidate: string): boolean {
  const address = candidate.replace(/^a=/, '').trim().split(/\s+/)[4]?.toLowerCase();
  if (!address) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const octets = address.split('.').map(Number);
    return (
      octets.every((n) => n >= 0 && n <= 255) &&
      octets[0] !== 0 &&
      octets[0] !== 127 &&
      octets[0]! < 224 &&
      !(octets[0] === 169 && octets[1] === 254)
    );
  }
  if (!address.includes(':') || !/^[a-f0-9:]+$/.test(address)) return false;
  return !['::', '::1'].includes(address) && !/^fe[89ab]|^ff|^::ffff:/.test(address);
}
export function publicSDP(sdp: string): string {
  return sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') || candidateAllowed(line))
    .join('\r\n');
}

/** Asks the encoder to drop frames rather than resolution (screen sharing). */
async function keepResolution(sender: RTCRtpSender): Promise<void> {
  try {
    const parameters = sender.getParameters() as RTCRtpSendParameters & {
      degradationPreference?: string;
    };
    parameters.degradationPreference = 'maintain-resolution';
    await sender.setParameters(parameters);
  } catch {
    // Older browsers do not support it; contentHint still applies.
  }
}
