import type { PlaybackState } from '../types/sync';
import { createStore, type Store } from '../utils/store';
import { projectPosition } from './syncProtocol';

type StateInput = Omit<PlaybackState, 'epoch' | 'rev' | 'at'>;

/** Position jumps smaller than this are treated as natural playback, not a seek. */
const SEEK_THRESHOLD_S = 0.25;

/**
 * Host side: owns the authoritative playback state and decides when a change
 * is meaningful enough to broadcast. Continuous time progress is never sent —
 * receivers extrapolate it from (position, rate, at).
 */
export class SyncPublisher {
  readonly epoch: string;
  private state: PlaybackState | null = null;

  constructor(
    private readonly now: () => number,
    private readonly send: (state: PlaybackState, to?: string[]) => void,
    epoch?: string,
  ) {
    this.epoch = epoch ?? crypto.randomUUID().slice(0, 12);
  }

  get current(): PlaybackState | null {
    return this.state;
  }

  /** Returns true if a message was sent. */
  update(input: StateInput): boolean {
    const at = this.now();
    const prev = this.state;
    if (prev && !this.isMeaningful(prev, input, at)) return false;
    this.state = { ...input, epoch: this.epoch, rev: (prev?.rev ?? -1) + 1, at };
    this.send(this.state);
    return true;
  }

  /** Targeted snapshot for a participant that just joined. */
  sendSnapshot(identity: string): void {
    if (this.state) this.send(this.state, [identity]);
  }

  private isMeaningful(prev: PlaybackState, next: StateInput, at: number): boolean {
    if (
      prev.status !== next.status ||
      prev.sourceId !== next.sourceId ||
      prev.sourceKind !== next.sourceKind ||
      prev.rate !== next.rate ||
      prev.title !== next.title ||
      prev.duration !== next.duration ||
      prev.transport !== next.transport
    ) {
      return true;
    }
    const expected = projectPosition(prev, at);
    return Math.abs(expected - next.position) > SEEK_THRESHOLD_S;
  }
}

export interface ReceiverState {
  playback: PlaybackState | null;
  /** Messages dropped as stale/duplicate (diagnostic). */
  dropped: number;
}

/** Listener side: accepts only newer revisions and projects the current position. */
export class SyncReceiver {
  readonly store: Store<ReceiverState> = createStore<ReceiverState>({ playback: null, dropped: 0 });

  constructor(private readonly now: () => number) {}

  accept(next: PlaybackState): boolean {
    const cur = this.store.get().playback;
    if (cur && cur.epoch === next.epoch && next.rev <= cur.rev) {
      this.store.set((s) => ({ dropped: s.dropped + 1 }));
      return false;
    }
    this.store.set({ playback: next });
    return true;
  }

  position(): number | null {
    const p = this.store.get().playback;
    return p ? projectPosition(p, this.now()) : null;
  }

  reset(): void {
    this.store.set({ playback: null });
  }
}
