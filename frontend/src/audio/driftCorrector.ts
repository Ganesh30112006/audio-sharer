/**
 * Gradual drift correction for followers playing the same media as a leader.
 *
 * Small offsets are absorbed by nudging playbackRate (pitch is preserved by
 * browsers by default), so playback never stops. Only gross offsets — after a
 * stall or device switch — fall back to a single seek.
 */
export interface DriftPolicy {
  /** Offsets within ± this many seconds are left alone. */
  deadband: number;
  /** Maximum relative rate change, e.g. 0.02 = ±2 %. */
  maxRateDelta: number;
  /** Seconds over which a drift should be absorbed. */
  convergeSeconds: number;
  /** Beyond this offset, seek instead of rate-correct. */
  seekThreshold: number;
}

export const DEFAULT_DRIFT_POLICY: DriftPolicy = {
  deadband: 0.015,
  maxRateDelta: 0.02,
  convergeSeconds: 2,
  seekThreshold: 0.5,
};

export type DriftAction =
  | { kind: 'none'; rate: number }
  | { kind: 'rate'; rate: number }
  | { kind: 'seek'; position: number; rate: number };

/**
 * @param drift follower position minus target position, seconds (positive = ahead)
 * @param target position the follower should be at, seconds
 * @param baseRate the leader's playback rate
 */
export function correctDrift(
  drift: number,
  target: number,
  baseRate: number,
  policy: DriftPolicy = DEFAULT_DRIFT_POLICY,
): DriftAction {
  const abs = Math.abs(drift);
  if (!Number.isFinite(drift)) return { kind: 'none', rate: baseRate };
  if (abs > policy.seekThreshold)
    return { kind: 'seek', position: Math.max(0, target), rate: baseRate };
  if (abs <= policy.deadband) return { kind: 'none', rate: baseRate };
  const delta = Math.min(policy.maxRateDelta, abs / policy.convergeSeconds);
  // Ahead -> slow down; behind -> speed up.
  const rate = baseRate * (drift > 0 ? 1 - delta : 1 + delta);
  return { kind: 'rate', rate: Math.round(rate * 10_000) / 10_000 };
}
