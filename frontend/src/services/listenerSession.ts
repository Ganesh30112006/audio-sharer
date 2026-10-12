import { MultiOutputPlayer } from '../audio/MultiOutputPlayer';
import { DEFAULT_OUTPUT } from '../audio/outputDevices';
import type { RoomInfo } from '../types/room';
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
  private disposer = new Disposer();
  private disposed = false;

  constructor(readonly code: string) {
    this.disposer.add(
      this.conn.events.on('remoteAudio', ({ stream }) => {
        this.outputs.setSource(stream ? { kind: 'stream', stream } : null);
        this.store.set({ hasAudio: !!stream });
      }),
    );
    this.disposer.add(
      this.conn.events.on('data', ({ payload, from }) => {
        if (from !== HOST_IDENTITY) return;
        const state = decodeState(payload);
        if (state) this.sync.accept(state);
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
    const stable = settingsStore.get().bufferMode === 'stable';
    this.conn.setPlayoutDelay(stable ? STABLE_BUFFER_SECONDS : 0);
  }

  async leave(): Promise<void> {
    this.store.set({ phase: 'left' });
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposer.dispose();
    this.outputs.dispose();
    await this.conn.disconnect();
    this.sync.reset();
  }
}
