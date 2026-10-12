import { LOSSLESS_TARGET_MS, LosslessReceiver } from '../audio/lossless/LosslessReceiver';
import { MultiOutputPlayer } from '../audio/MultiOutputPlayer';
import { DEFAULT_OUTPUT } from '../audio/outputDevices';
import type { RoomInfo } from '../types/room';
import { PCM_TOPIC, SYNC_TOPIC, type Transport } from '../types/sync';
import { ServerClock } from '../utils/clock';
import { Disposer } from '../utils/disposer';
import { createStore, type Store } from '../utils/store';
import { api } from './api';
import { HOST_IDENTITY, RoomConnection } from './roomConnection';
import { settingsStore, STABLE_BUFFER_SECONDS } from './settings';
import { decodeState } from './syncProtocol';
import { SyncReceiver } from './syncService';

export type ListenerPhase = 'idle' | 'joining' | 'joined' | 'left' | 'error';

export interface ListenerState {
  phase: ListenerPhase;
  room: RoomInfo | null;
  hasAudio: boolean;
  error: string | null;
}

/**
 * One listener's participation in a room: receive-only SFU connection, the
 * host's playback state, and local output routing.
 */
export class ListenerSession {
  readonly conn = new RoomConnection('listener');
  readonly outputs = new MultiOutputPlayer();
  readonly clock = new ServerClock(api.serverTime);
  readonly sync = new SyncReceiver(() => this.clock.now());
  readonly store: Store<ListenerState> = createStore<ListenerState>({
    phase: 'idle',
    room: null,
    hasAudio: false,
    error: null,
  });
  readonly lossless = new LosslessReceiver(() => this.clock.now());
  private disposer = new Disposer();
  private disposed = false;
  private remoteStream: MediaStream | null = null;
  private losslessStream: MediaStream | null = null;
  private playing: MediaStream | null = null;

  constructor(readonly code: string) {
    this.disposer.add(
      this.conn.events.on('remoteAudio', ({ stream }) => {
        this.remoteStream = stream;
        this.selectSource();
      }),
    );
    this.disposer.add(
      this.lossless.events.on('stream', (stream) => {
        this.losslessStream = stream;
        this.selectSource();
      }),
    );
    this.disposer.add(
      this.conn.events.on('data', ({ payload, from, topic }) => {
        if (from !== HOST_IDENTITY) return;
        if (topic === PCM_TOPIC) {
          this.lossless.push(payload);
        } else if (topic === SYNC_TOPIC) {
          const state = decodeState(payload);
          if (state && this.sync.accept(state)) this.selectSource();
        }
      }),
    );
    this.disposer.add(settingsStore.subscribe(() => this.applyBufferMode()));
  }

  async loadRoom(): Promise<RoomInfo | null> {
    try {
      const room = await api.getRoom(this.code);
      this.store.set({ room });
      // Start SDK download, DNS and TLS to the SFU while the user reads the page.
      void this.conn.prewarm(room.sfu_url);
      void this.clock.sync();
      return room;
    } catch (err) {
      this.store.set({ phase: 'error', error: (err as Error).message });
      return null;
    }
  }

  /** Call from a user gesture so playback is allowed to start. */
  async join(displayName: string): Promise<void> {
    const { phase } = this.store.get();
    if (phase === 'joining' || phase === 'joined') return;
    this.store.set({ phase: 'joining', error: null });
    if (this.outputs.store.get().slots.length === 0) {
      await this.outputs.addOutput(DEFAULT_OUTPUT);
    }
    // Registers intent to play inside the gesture; actual audio starts on track arrival.
    void this.outputs.play();
    try {
      const [grant] = await Promise.all([
        api.token(this.code, 'listener', displayName || 'Listener'),
        this.clock.current ? undefined : this.clock.sync(),
      ]);
      if (this.disposed) return;
      await this.conn.connect(grant);
      if (this.disposed) return;
      this.applyBufferMode();
      this.store.set({ phase: 'joined' });
    } catch (err) {
      if (this.disposed) return;
      this.store.set({ phase: 'error', error: (err as Error).message });
    }
  }

  private applyBufferMode(): void {
    const mode = settingsStore.get().bufferMode;
    this.conn.setPlayoutDelay(mode === 'stable' ? STABLE_BUFFER_SECONDS : 0);
    this.lossless.setTargetMs(LOSSLESS_TARGET_MS[mode], mode === 'auto');
  }

  /** The host announces its transport in the sync state; play the matching stream. */
  private selectSource(): void {
    const announced = this.sync.store.get().playback?.transport;
    const transport: Transport = announced ?? (this.losslessStream ? 'lossless' : 'opus');
    if (transport === 'opus' && this.losslessStream) this.lossless.stop();
    const stream = transport === 'lossless' ? this.losslessStream : this.remoteStream;
    if (stream !== this.playing) {
      this.playing = stream;
      this.outputs.setSource(stream ? { kind: 'stream', stream } : null);
    }
    this.store.set({ hasAudio: !!stream });
  }

  /** Retry audio after an autoplay block; call from a user gesture. */
  async resumeAudio(): Promise<void> {
    await this.lossless.resume();
    await this.outputs.resume();
  }

  async leave(): Promise<void> {
    this.store.set({ phase: 'left' });
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposer.dispose();
    this.lossless.dispose();
    this.outputs.dispose();
    await this.conn.disconnect();
    this.sync.reset();
  }
}
