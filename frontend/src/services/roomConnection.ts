import type {
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
} from 'livekit-client';
import type { SourcePolicy } from '../audio/sourcePolicy';
import type { ConnectionState, ParticipantSummary, Quality, Role, TokenGrant } from '../types/room';
import { PCM_TOPIC, SYNC_TOPIC } from '../types/sync';
import { Disposer } from '../utils/disposer';
import { Emitter } from '../utils/emitter';
import { createStore, type Store } from '../utils/store';

type LiveKit = typeof import('livekit-client');

let livekitModule: Promise<LiveKit> | null = null;

/** The SDK is loaded on demand so it never weighs on the initial shell. */
export function loadLiveKit(): Promise<LiveKit> {
  livekitModule ??= import('livekit-client').catch((err: unknown) => {
    livekitModule = null;
    throw err;
  });
  return livekitModule;
}

export const HOST_IDENTITY = 'host';

export interface RoomConnectionState {
  state: ConnectionState;
  participants: ParticipantSummary[];
  quality: Quality;
  reconnects: number;
  /** Duration of the last completed reconnection, ms. */
  lastRecoveryMs: number | null;
  publishing: boolean;
  error: string | null;
}

interface RoomEvents {
  data: { payload: Uint8Array; from: string; topic: string };
  remoteAudio: { stream: MediaStream | null; track: RemoteTrack | null };
  participantJoined: { identity: string };
  [key: string]: unknown;
}

const PARTICIPANT_FLUSH_MS = 150;

/**
 * Owns at most one SFU connection. Every call path is idempotent so React
 * StrictMode, double clicks and reconnect races cannot create duplicate
 * connections, publications or subscriptions.
 */
export class RoomConnection {
  readonly store: Store<RoomConnectionState> = createStore<RoomConnectionState>({
    state: 'idle',
    participants: [],
    quality: 'unknown',
    reconnects: 0,
    lastRecoveryMs: null,
    publishing: false,
    error: null,
  });
  readonly events = new Emitter<RoomEvents>();

  private room: Room | null = null;
  /** Room created by prewarm(); adopted by the first connect. */
  private prepared: Room | null = null;
  private connecting: Promise<void> | null = null;
  private disposer = new Disposer();
  private publication: LocalTrackPublication | null = null;
  private publishedPolicy: string | null = null;
  private remoteTrack: RemoteTrack | null = null;
  private reconnectStartedAt: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private playoutDelay = 0;
  private closed = false;

  constructor(private readonly role: Role) {}

  get isConnected(): boolean {
    return this.store.get().state === 'connected';
  }

  connect(grant: TokenGrant): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Connection was closed'));
    // Check the in-flight promise first: the Room is only created after the
    // SDK import resolves, so `this.room` alone can't guard concurrent calls.
    if (this.connecting) return this.connecting;
    if (this.room) return Promise.resolve();
    this.connecting = this.doConnect(grant).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Called as soon as the SFU URL is known (before the user clicks Join):
   * downloads the SDK chunk and lets it resolve DNS / open TLS to the SFU, so
   * the eventual connect skips those round trips.
   */
  async prewarm(url: string): Promise<void> {
    if (this.closed || this.room || this.prepared) return;
    try {
      const lk = await loadLiveKit();
      if (this.closed || this.room || this.prepared) return;
      this.prepared = this.createRoom(lk);
      await this.prepared.prepareConnection(url);
    } catch {
      // Best effort: connect() works without it.
    }
  }

  private createRoom(lk: LiveKit): Room {
    return new lk.Room({
      adaptiveStream: false,
      dynacast: false,
      disconnectOnPageLeave: true,
      webAudioMix: false,
      stopLocalTrackOnUnpublish: false,
    });
  }

  private async doConnect(grant: TokenGrant): Promise<void> {
    this.store.set({ state: 'connecting', error: null });
    const lk = await loadLiveKit();
    if (this.closed) return;
    const room = this.prepared ?? this.createRoom(lk);
    this.prepared = null;
    this.room = room;
    this.bindRoomEvents(lk, room);
    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: this.role === 'listener' });
    } catch (err) {
      this.room = null;
      this.disposer.dispose();
      this.disposer = new Disposer();
      this.store.set({ state: 'failed', error: describeConnectError(err) });
      throw err;
    }
    if (this.closed) {
      await room.disconnect();
      return;
    }
    this.store.set({ state: 'connected', quality: 'good' });
    this.scheduleParticipantFlush();
    // A listener joining after the host already published: pick up the existing track.
    if (this.role === 'listener') {
      const host = room.remoteParticipants.get(HOST_IDENTITY);
      host?.audioTrackPublications.forEach((pub) => {
        if (pub.track) this.handleRemoteTrack(pub.track, host);
      });
    }
  }

  private bindRoomEvents(lk: LiveKit, room: Room): void {
    const { RoomEvent, DisconnectReason } = lk;
    const on = <E extends Parameters<Room['on']>[0]>(
      event: E,
      handler: Parameters<Room['on']>[1],
    ) => {
      room.on(event, handler as never);
      this.disposer.add(() => room.off(event, handler as never));
    };

    on(RoomEvent.Reconnecting, () => this.markReconnecting());
    on(RoomEvent.SignalReconnecting, () => this.markReconnecting());
    on(RoomEvent.Reconnected, () => {
      const recovery = this.reconnectStartedAt ? performance.now() - this.reconnectStartedAt : null;
      this.reconnectStartedAt = null;
      this.store.set((s) => ({
        state: 'connected',
        reconnects: s.reconnects + 1,
        lastRecoveryMs: recovery,
      }));
    });
    on(RoomEvent.Disconnected, ((reason?: number) => {
      let error: string | null = null;
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        error = 'This room was opened as host in another tab or device.';
      } else if (reason === DisconnectReason.ROOM_DELETED) {
        error = 'The host ended this room.';
      } else if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        error = 'You were removed from the room.';
      }
      this.remoteTrack = null;
      this.publication = null;
      this.store.set({ state: 'disconnected', error, publishing: false, participants: [] });
      this.events.emit('remoteAudio', { stream: null, track: null });
    }) as never);
    on(RoomEvent.ParticipantConnected, ((p: RemoteParticipant) => {
      this.events.emit('participantJoined', { identity: p.identity });
      this.scheduleParticipantFlush();
    }) as never);
    on(RoomEvent.ParticipantDisconnected, () => this.scheduleParticipantFlush());
    on(RoomEvent.ConnectionQualityChanged, ((quality: string, p: Participant) => {
      if (p.identity === room.localParticipant.identity)
        this.store.set({ quality: quality as Quality });
      else this.scheduleParticipantFlush();
    }) as never);
    on(RoomEvent.DataReceived, ((
      payload: Uint8Array,
      p?: RemoteParticipant,
      _k?: unknown,
      topic?: string,
    ) => {
      if ((topic !== SYNC_TOPIC && topic !== PCM_TOPIC) || !p) return;
      this.events.emit('data', { payload, from: p.identity, topic });
    }) as never);

    if (this.role === 'listener') {
      on(RoomEvent.TrackSubscribed, ((track: RemoteTrack, _pub: unknown, p: RemoteParticipant) => {
        this.handleRemoteTrack(track, p);
      }) as never);
      on(RoomEvent.TrackUnsubscribed, ((track: RemoteTrack) => {
        if (track === this.remoteTrack) {
          this.remoteTrack = null;
          this.events.emit('remoteAudio', { stream: null, track: null });
        }
      }) as never);
    }
  }

  private markReconnecting(): void {
    this.reconnectStartedAt ??= performance.now();
    this.store.set({ state: 'reconnecting' });
  }

  private handleRemoteTrack(track: RemoteTrack, p: RemoteParticipant): void {
    // Only the host's audio is played; ignore anything else and duplicates.
    if (p.identity !== HOST_IDENTITY || track.kind !== 'audio') return;
    if (this.remoteTrack?.sid === track.sid) return;
    this.remoteTrack = track;
    this.applyPlayoutDelay();
    this.events.emit('remoteAudio', { stream: new MediaStream([track.mediaStreamTrack]), track });
  }

  /** Batch participant churn into one store update instead of one per event. */
  private scheduleParticipantFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const room = this.room;
      if (!room) return;
      const participants: ParticipantSummary[] = [];
      room.remoteParticipants.forEach((p) => {
        participants.push({
          identity: p.identity,
          name: p.name || p.identity,
          role: p.identity === HOST_IDENTITY ? 'host' : 'listener',
          quality: p.connectionQuality as Quality,
        });
      });
      participants.sort((a, b) => a.name.localeCompare(b.name));
      this.store.set({ participants });
    }, PARTICIPANT_FLUSH_MS);
  }

  /**
   * Publish (or swap) the host audio track. When the transport policy is
   * unchanged the sender's track is replaced in place: no renegotiation and
   * listeners keep their existing subscription.
   */
  async publishAudio(track: MediaStreamTrack, policy: SourcePolicy, name: string): Promise<void> {
    const room = this.room;
    if (!room || this.role !== 'host') throw new Error('Not connected as host');
    const lk = await loadLiveKit();
    const key = JSON.stringify([policy.publish, policy.trackSource]);
    const existing = this.publication?.audioTrack;
    if (existing && this.publishedPolicy === key) {
      if (existing.mediaStreamTrack !== track) await existing.replaceTrack(track, true);
      return;
    }
    await this.unpublishAudio();
    this.publication = await room.localParticipant.publishTrack(track, {
      name,
      source:
        policy.trackSource === 'microphone'
          ? lk.Track.Source.Microphone
          : lk.Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: policy.publish.maxBitrate },
      dtx: policy.publish.dtx,
      red: policy.publish.red,
      forceStereo: policy.publish.forceStereo,
      stopMicTrackOnMute: false,
    });
    this.publishedPolicy = key;
    this.store.set({ publishing: true });
  }

  async unpublishAudio(): Promise<void> {
    const pub = this.publication;
    this.publication = null;
    this.publishedPolicy = null;
    if (pub?.track && this.room) {
      // We own the MediaStreamTrack; the caller decides when to stop it.
      await this.room.localParticipant.unpublishTrack(pub.track, false);
    }
    this.store.set({ publishing: false });
  }

  async sendData(
    payload: Uint8Array<ArrayBuffer>,
    to?: string[],
    topic = SYNC_TOPIC,
  ): Promise<void> {
    const room = this.room;
    if (!room || this.store.get().state !== 'connected') return;
    await room.localParticipant.publishData(payload, {
      reliable: true,
      topic,
      destinationIdentities: to,
    });
  }

  /**
   * Extra receive buffering (seconds). Higher values trade latency for fewer
   * dropouts on unstable networks.
   */
  setPlayoutDelay(seconds: number): void {
    this.playoutDelay = seconds;
    this.applyPlayoutDelay();
  }

  private applyPlayoutDelay(): void {
    const receiver = this.remoteTrack?.receiver as
      (RTCRtpReceiver & { jitterBufferTarget?: number | null }) | undefined;
    if (!receiver) return;
    if ('jitterBufferTarget' in receiver) {
      receiver.jitterBufferTarget = this.playoutDelay > 0 ? this.playoutDelay * 1000 : null;
    } else {
      this.remoteTrack?.setPlayoutDelay(this.playoutDelay);
    }
  }

  async getStats(): Promise<RTCStatsReport | undefined> {
    if (this.role === 'listener') return this.remoteTrack?.getRTCStatsReport();
    return this.publication?.track?.getRTCStatsReport();
  }

  async startAudio(): Promise<void> {
    await this.room?.startAudio();
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.connecting?.catch(() => undefined);
    const room = this.room ?? this.prepared;
    this.room = null;
    this.prepared = null;
    this.publication = null;
    this.remoteTrack = null;
    this.disposer.dispose();
    if (room) await room.disconnect(true).catch(() => undefined);
    this.events.clear();
    this.store.set({ state: 'disconnected', participants: [], publishing: false });
  }
}

function describeConnectError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/permission|401|unauthor/i.test(msg)) return 'The room rejected this session. Try rejoining.';
  if (/timeout|timed out/i.test(msg)) return 'Timed out reaching the audio server.';
  return 'Could not connect to the audio server.';
}
