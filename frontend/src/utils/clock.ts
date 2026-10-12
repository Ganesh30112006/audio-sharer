/**
 * Clock alignment between this device and the control-plane server.
 *
 * All local elapsed-time math uses performance.now() (monotonic). The offset
 * maps the monotonic clock onto server wall-clock milliseconds:
 *   serverTime ≈ performance.now() + offset
 * Estimated NTP-style from the sample with the smallest round trip, which has
 * the tightest bound on transport delay asymmetry.
 */
export interface ClockSample {
  /** monotonic ms when the request was sent */
  t0: number;
  /** server wall-clock ms in the response */
  server: number;
  /** monotonic ms when the response arrived */
  t1: number;
}

export interface ClockEstimate {
  offset: number;
  rtt: number;
  /** ± uncertainty in ms (half the best round trip) */
  uncertainty: number;
}

export function estimateOffset(samples: ClockSample[]): ClockEstimate | undefined {
  let best: ClockSample | undefined;
  for (const s of samples) {
    if (s.t1 < s.t0 || !Number.isFinite(s.server)) continue;
    if (!best || s.t1 - s.t0 < best.t1 - best.t0) best = s;
  }
  if (!best) return undefined;
  const rtt = best.t1 - best.t0;
  return { offset: best.server - (best.t0 + rtt / 2), rtt, uncertainty: rtt / 2 };
}

export class ServerClock {
  private estimate: ClockEstimate | undefined;

  constructor(private readonly fetchServerTime: () => Promise<number>) {}

  /** A handful of sequential samples; cheap and done once per session. */
  async sync(count = 5): Promise<ClockEstimate | undefined> {
    const samples: ClockSample[] = [];
    for (let i = 0; i < count; i++) {
      try {
        const t0 = performance.now();
        const server = await this.fetchServerTime();
        samples.push({ t0, server, t1: performance.now() });
      } catch {
        // Ignore failed samples; fall back to the local clock if all fail.
      }
    }
    this.estimate = estimateOffset(samples) ?? this.estimate;
    return this.estimate;
  }

  get current(): ClockEstimate | undefined {
    return this.estimate;
  }

  /** Server wall-clock ms; falls back to the local wall clock when unsynced. */
  now(): number {
    return this.estimate ? performance.now() + this.estimate.offset : Date.now();
  }
}
