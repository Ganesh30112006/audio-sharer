/**
 * Flow-control primitives for the lossless pipeline.
 *
 * Every hand-off (encode, network send, decode) is a BoundedQueue limited by
 * block count, bytes and the age of its oldest entry. Exceeding any limit
 * does not silently discard audio: the owning pipeline enters an explicit
 * interruption, which is recorded (cause, start, duration, frames lost) and
 * announced downstream with a discontinuity flag. No finite queue can absorb
 * sustained overload; the policy is bounded latency first, then a reported
 * interruption.
 */
export interface QueueLimits {
  maxBlocks: number;
  maxBytes: number;
  maxAgeMs: number;
  /** Resume admitting once every dimension is at or below this fraction of its limit. */
  resumeFraction: number;
}

export interface QueueSnapshot {
  blocks: number;
  bytes: number;
  oldestAgeMs: number;
}

interface Entry {
  id: number;
  bytes: number;
  t: number;
}

/** FIFO bookkeeping of in-flight work (the payloads themselves live elsewhere). */
export class BoundedQueue {
  private entries: Entry[] = [];
  private head = 0;
  private bytes = 0;
  /** High-water marks since creation. */
  readonly peak = { blocks: 0, bytes: 0, oldestAgeMs: 0 };

  constructor(
    readonly limits: QueueLimits,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.entries.length - this.head;
  }

  push(id: number, bytes: number): void {
    this.entries.push({ id, bytes, t: this.now() });
    this.bytes += bytes;
    this.peak.blocks = Math.max(this.peak.blocks, this.size);
    this.peak.bytes = Math.max(this.peak.bytes, this.bytes);
  }

  /** Completes the oldest entry; returns its id (entries complete in order). */
  shift(): Entry | undefined {
    if (this.head >= this.entries.length) return undefined;
    const e = this.entries[this.head++]!;
    this.bytes -= e.bytes;
    if (this.head > 1024 && this.head * 2 > this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
    return e;
  }

  /** Removes a specific entry (out-of-order completion, e.g. a failed send). */
  remove(id: number): Entry | undefined {
    for (let i = this.head; i < this.entries.length; i++) {
      if (this.entries[i]!.id === id) {
        const [e] = this.entries.splice(i, 1);
        this.bytes -= e!.bytes;
        return e;
      }
    }
    return undefined;
  }

  clear(): void {
    this.entries = [];
    this.head = 0;
    this.bytes = 0;
  }

  snapshot(): QueueSnapshot {
    const oldest = this.entries[this.head];
    const oldestAgeMs = oldest ? this.now() - oldest.t : 0;
    this.peak.oldestAgeMs = Math.max(this.peak.oldestAgeMs, oldestAgeMs);
    return { blocks: this.size, bytes: this.bytes, oldestAgeMs };
  }

  /** Which limit is exceeded, if any. */
  overLimit(): 'blocks' | 'bytes' | 'age' | null {
    const s = this.snapshot();
    if (s.blocks > this.limits.maxBlocks) return 'blocks';
    if (s.bytes > this.limits.maxBytes) return 'bytes';
    if (s.oldestAgeMs > this.limits.maxAgeMs) return 'age';
    return null;
  }

  /** True when drained enough to resume after an interruption (hysteresis). */
  belowResume(): boolean {
    const s = this.snapshot();
    const f = this.limits.resumeFraction;
    return (
      s.blocks <= this.limits.maxBlocks * f &&
      s.bytes <= this.limits.maxBytes * f &&
      s.oldestAgeMs <= this.limits.maxAgeMs * f
    );
  }
}

export type InterruptionCause =
  | 'capture-gap'
  | 'session-reset'
  | 'stale-capture'
  | 'encoder-overload'
  | 'network-congestion'
  | 'transport-error'
  | 'decoder-overload'
  | 'upstream-gap';

export interface Interruption {
  cause: InterruptionCause;
  /** Which limit tripped, when applicable. */
  limit: 'blocks' | 'bytes' | 'age' | null;
  startedAt: number;
  endedAt: number | null;
  /** Blocks/frames not delivered during this interruption. */
  droppedBlocks: number;
  droppedFrames: number;
  /** For capture-side events: the producing generation and timeline range. */
  detail?: { generation: number; firstFrame: number; frames: number };
}

/** Records interruptions; keeps the last `keep` in full plus running totals. */
export class InterruptionLog {
  private list: Interruption[] = [];
  current: Interruption | null = null;
  total = 0;
  totalMs = 0;
  totalDroppedFrames = 0;

  constructor(
    private readonly now: () => number,
    private readonly keep = 20,
  ) {}

  begin(cause: InterruptionCause, limit: Interruption['limit']): Interruption {
    if (this.current) return this.current;
    this.current = { cause, limit, startedAt: this.now(), endedAt: null, droppedBlocks: 0, droppedFrames: 0 };
    this.total++;
    return this.current;
  }

  drop(frames: number): void {
    if (!this.current) return;
    this.current.droppedBlocks++;
    this.current.droppedFrames += frames;
    this.totalDroppedFrames += frames;
  }

  /**
   * Frames lost to an interruption that may already have ended (blocks that
   * were in flight when it began). Counted in totals and, if still open, in
   * the current record.
   */
  dropUnattributed(frames: number): void {
    if (this.current) {
      this.drop(frames);
      return;
    }
    const last = this.list[this.list.length - 1];
    if (last) {
      last.droppedBlocks++;
      last.droppedFrames += frames;
    }
    this.totalDroppedFrames += frames;
  }

  end(): Interruption | null {
    const c = this.current;
    if (!c) return null;
    c.endedAt = this.now();
    this.totalMs += c.endedAt - c.startedAt;
    this.list.push(c);
    if (this.list.length > this.keep) this.list.shift();
    this.current = null;
    return c;
  }

  get recent(): readonly Interruption[] {
    return this.list;
  }
}
