import type { PlaybackState, PlaybackStatus, SourceKind } from '../types/sync';

const STATUSES: readonly PlaybackStatus[] = ['playing', 'paused', 'stopped'];
const KINDS: readonly SourceKind[] = ['file', 'capture', 'microphone'];
const MAX_MESSAGE_BYTES = 2048;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeState(state: PlaybackState): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({ t: 'state', s: state }));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown, max: number): v is string | null =>
  v === null || (typeof v === 'string' && v.length <= max);

/**
 * Parse and validate an incoming sync message. Anything malformed, oversized
 * or out of range returns null and is ignored by the receiver.
 */
export function decodeState(bytes: Uint8Array): PlaybackState | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MESSAGE_BYTES) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null || (msg as { t?: unknown }).t !== 'state')
    return null;
  const s = (msg as { s?: unknown }).s as Record<string, unknown> | undefined;
  if (typeof s !== 'object' || s === null) return null;
  if (typeof s.epoch !== 'string' || s.epoch.length === 0 || s.epoch.length > 64) return null;
  if (!isNum(s.rev) || s.rev < 0 || !Number.isInteger(s.rev)) return null;
  if (!STATUSES.includes(s.status as PlaybackStatus)) return null;
  if (!isNum(s.position) || s.position < 0) return null;
  if (!isNum(s.rate) || s.rate <= 0 || s.rate > 4) return null;
  if (!isNum(s.at)) return null;
  if (!strOrNull(s.sourceId, 64) || !strOrNull(s.title, 256)) return null;
  if (s.sourceKind !== null && !KINDS.includes(s.sourceKind as SourceKind)) return null;
  if (s.duration !== null && (!isNum(s.duration) || s.duration < 0)) return null;
  return {
    epoch: s.epoch,
    rev: s.rev,
    status: s.status as PlaybackStatus,
    position: s.position,
    rate: s.rate,
    sourceId: s.sourceId,
    sourceKind: s.sourceKind as SourceKind | null,
    title: s.title,
    duration: s.duration as number | null,
    at: s.at,
  };
}

/** Media position implied by `state` at server time `serverNow` (ms). */
export function projectPosition(state: PlaybackState, serverNow: number): number {
  if (state.status !== 'playing') return state.position;
  const elapsed = Math.max(0, (serverNow - state.at) / 1000);
  const pos = state.position + elapsed * state.rate;
  return state.duration !== null ? Math.min(pos, state.duration) : pos;
}
