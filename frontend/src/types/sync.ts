export type PlaybackStatus = 'playing' | 'paused' | 'stopped';
export type SourceKind = 'file' | 'capture' | 'microphone';
/** opus: WebRTC media track (lowest latency). lossless: PCM blocks over the reliable data channel. */
export type Transport = 'opus' | 'lossless';

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
  transport: Transport;
}

export const SYNC_TOPIC = 'mc.sync.v1';
export const PCM_TOPIC = 'mc.pcm.v1';
