/**
 * Turns render quanta into fixed-size integer PCM blocks (pure logic; runs
 * inside the capture AudioWorklet, unit-tested directly).
 *
 * Continuity rules:
 * - Positions come from the AudioContext timeline (`currentFrame`).
 * - If the timeline advances without this code seeing those frames (the
 *   engine skipped process() calls), the partial block is flushed as-is and
 *   the next block reports `gapBefore` = unseen frames. Never silent.
 * - If the channel layout changes, the partial block is flushed with its
 *   original layout and valid-frame count; layouts are never mixed.
 * - An inactive input after the stream started is silence, captured as zeros.
 */
export interface CapturedBlock {
  samples: Int32Array<ArrayBuffer>;
  channels: number;
  /** Timeline position (frames, mod 2^32) of the first frame. */
  frame: number;
  /** Timeline frames not captured immediately before this block (0 = continuous). */
  gapBefore: number;
}

export class BlockAssembler {
  private readonly scale: number;
  private readonly lo: number;
  private readonly hi: number;
  private channels = 0;
  private buf: Int32Array<ArrayBuffer> | null = null;
  private filled = 0;
  private blockStart = 0;
  /** Timeline position expected for the next input quantum (-1 = none yet). */
  private nextFrame = -1;
  private pendingGap = 0;
  /** Diagnostics */
  quanta = 0;
  unseenFrames = 0;
  inactiveQuanta = 0;
  layoutChanges = 0;

  constructor(
    private readonly blockFrames: number,
    bitDepth: number,
    private readonly emit: (block: CapturedBlock) => void,
  ) {
    this.scale = 2 ** (bitDepth - 1);
    this.lo = -this.scale;
    this.hi = this.scale - 1;
  }

  /**
   * @param input channel arrays for this quantum, or null/empty when inactive
   * @param frame timeline position of the quantum's first frame
   * @param length quantum length in frames (128 in browsers)
   */
  push(input: Float32Array[] | null, frame: number, length: number): void {
    this.quanta++;
    if (this.nextFrame >= 0 && frame !== this.nextFrame) {
      // The timeline moved without us seeing those frames: close the block here.
      const unseen = frame - this.nextFrame;
      this.unseenFrames += unseen;
      this.flushPartial();
      this.pendingGap += unseen;
    }
    this.nextFrame = frame + length;

    const active = !!input && input.length > 0;
    if (!active) {
      this.inactiveQuanta++;
      if (this.channels === 0) {
        // Stream not started yet: nothing to capture, and no gap to report.
        this.nextFrame = -1;
        return;
      }
    } else if (input.length !== this.channels) {
      if (this.channels !== 0) this.layoutChanges++;
      this.flushPartial();
      this.channels = input.length;
      this.buf = null;
    }

    const ch = this.channels;
    for (let i = 0; i < length; i++) {
      if (!this.buf) this.buf = new Int32Array(this.blockFrames * ch);
      if (this.filled === 0) this.blockStart = frame + i;
      const base = this.filled * ch;
      for (let c = 0; c < ch; c++) {
        let v = active ? Math.round(input![c]![i]! * this.scale) : 0;
        if (v < this.lo) v = this.lo;
        else if (v > this.hi) v = this.hi;
        this.buf[base + c] = v;
      }
      if (++this.filled === this.blockFrames) this.flush(this.buf);
    }
  }

  private flush(samples: Int32Array<ArrayBuffer>): void {
    this.emit({ samples, channels: this.channels, frame: this.blockStart >>> 0, gapBefore: this.pendingGap });
    this.pendingGap = 0;
    this.buf = null;
    this.filled = 0;
  }

  /** Emit the frames captured so far with their own layout and count. */
  private flushPartial(): void {
    if (!this.buf || this.filled === 0) return;
    this.flush(this.buf.slice(0, this.filled * this.channels));
  }

  /** Stop: emit the final partial block so nothing captured is lost. */
  finish(): void {
    this.flushPartial();
  }
}
