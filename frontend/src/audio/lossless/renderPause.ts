/**
 * Detects that a capture AudioContext stood still while wall time ran on
 * (it was suspended, e.g. the host paused and the idle graph was suspended).
 *
 * The captured samples stay contiguous across a suspension, so nothing in the
 * sample timeline shows it. But the listener measures jitter against that
 * timeline, and would read the pause as network delay (and inflate its buffer
 * by the pause length). The sender therefore marks the first block after such
 * a pause as a discontinuity, and the listener restarts playback cleanly.
 *
 * A stall of the page thread is not a pause: the render clock keeps running,
 * blocks are only delivered late, so both clocks advance alike.
 */
export class RenderPauseDetector {
  private lastWall = NaN;
  private lastCtx = NaN;

  constructor(private readonly thresholdMs = 1000) {}

  /**
   * Call once per captured block with the page clock and the context's
   * currentTime (both ms). Returns true if the context was paused since the
   * previous call for longer than the threshold.
   */
  check(wallMs: number, ctxMs: number): boolean {
    const paused =
      Number.isFinite(this.lastWall) &&
      wallMs - this.lastWall - (ctxMs - this.lastCtx) > this.thresholdMs;
    this.lastWall = wallMs;
    this.lastCtx = ctxMs;
    return paused;
  }

  reset(): void {
    this.lastWall = this.lastCtx = NaN;
  }
}
