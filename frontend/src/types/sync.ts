export type PlaybackStatus = 'playing' | 'paused' | 'stopped';
export type SourceKind = 'file' | 'capture' | 'microphone';

/** Authoritative playback state published by the host (kept intentionally small). */
export interface PlaybackState {
  /** Random per host session; a new epoch resets revision ordering. */
  epoch: string;
  /** Monotonically increasing per epoch. */
  rev: number;
  status: PlaybackStatus;
  /** Media position in seconds at `at`. */
  position: number;
  rate: number;
  sourceId: string | null;
  sourceKind: SourceKind | null;
  title: string | null;
  /** Duration in seconds; null for live/unknown. */
  duration: number | null;
  /** Server wall-clock ms of this state change. */
  at: number;
}

export const SYNC_TOPIC = 'mc.sync.v1';
