/**
 * Opt-in per-block latency trace for the lossless pipeline (benchmarks and
 * diagnostics). Enabled with `localStorage['mc.latencyTrace'] = '1'`; when
 * disabled nothing is allocated and the hot path does a single null check.
 *
 * Clock domains are never mixed implicitly. Every column name ends with its
 * domain:
 *   H   host page monotonic clock, performance.now() (ms)
 *   HA  host AudioContext render clock, currentTime (ms)
 *   L   listener page monotonic clock, performance.now() (ms)
 *   LA  listener AudioContext render clock, currentTime (ms)
 *   Ms  a duration measured inside one domain
 * Values cross domains only through an explicit, recorded mapping:
 *   - render clock -> page clock: `ContextClockMap` (lower envelope of
 *     performance.now() - currentTime, sampled on the page thread);
 *   - page clock -> server clock: the session's ServerClock offset, recorded
 *     per row together with its ± uncertainty, so host and listener times are
 *     only compared on the server clock and the error bound travels with them.
 */
import type { ClockEstimate } from '../../utils/clock';

export function latencyTraceEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('mc.latencyTrace') === '1';
  } catch {
    return false;
  }
}

/**
 * Maps an AudioContext's render clock onto the page's performance.now().
 *
 * The page thread reads `currentTime` as of the last rendered quantum, so
 * `performance.now() - currentTime` is smallest right after a render. The
 * minimum over a sliding window (two 2 s buckets) estimates the offset of the
 * render timeline; render bursts and page-thread lag only ever add to it.
 */
export class ContextClockMap {
  private cur = Infinity;
  private prev = Infinity;
  private bucketStart = -Infinity;

  sample(ctx: BaseAudioContext, now = performance.now()): void {
    if (now - this.bucketStart > 2000) {
      this.prev = this.cur;
      this.cur = Infinity;
      this.bucketStart = now;
    }
    const v = now - ctx.currentTime * 1000;
    if (v < this.cur) this.cur = v;
  }

  /** page ms = render ms + offset; NaN until sampled. */
  get offset(): number {
    const o = Math.min(this.cur, this.prev);
    return Number.isFinite(o) ? o : NaN;
  }
}

/** Fixed-capacity table of per-block rows addressed by sequence number. */
export class TraceTable<C extends string> {
  private readonly index: Record<C, number>;
  private readonly width: number;
  private readonly data: Float64Array;
  private readonly seqs: Float64Array;

  constructor(
    readonly cols: readonly C[],
    readonly capacity = 16_384,
  ) {
    this.index = Object.fromEntries(cols.map((c, i) => [c, i])) as Record<C, number>;
    this.width = cols.length;
    this.data = new Float64Array(capacity * this.width).fill(NaN);
    this.seqs = new Float64Array(capacity).fill(NaN);
  }

  private row(seq: number): number {
    const r = seq % this.capacity;
    if (this.seqs[r] !== seq) {
      this.seqs[r] = seq;
      this.data.fill(NaN, r * this.width, (r + 1) * this.width);
    }
    return r * this.width;
  }

  set(seq: number, col: C, value: number): void {
    this.data[this.row(seq) + this.index[col]] = value;
  }

  /** Sets a value only if the row has none yet (first observation wins). */
  setOnce(seq: number, col: C, value: number): void {
    const i = this.row(seq) + this.index[col];
    if (Number.isNaN(this.data[i]!)) this.data[i] = value;
  }

  get(seq: number, col: C): number {
    const r = seq % this.capacity;
    return this.seqs[r] === seq ? this.data[r * this.width + this.index[col]]! : NaN;
  }

  /** Rows ordered by sequence number; NaN marks a stage the block never reached. */
  dump(): { cols: readonly C[]; seq: number[]; rows: number[][] } {
    const order: number[] = [];
    for (let r = 0; r < this.capacity; r++) if (!Number.isNaN(this.seqs[r]!)) order.push(r);
    order.sort((a, b) => this.seqs[a]! - this.seqs[b]!);
    return {
      cols: this.cols,
      seq: order.map((r) => this.seqs[r]!),
      rows: order.map((r) => Array.from(this.data.subarray(r * this.width, (r + 1) * this.width))),
    };
  }
}

/** Long tasks (> 50 ms on the page thread), in page-clock ms. */
function observeLongTasks(): { list: Array<[number, number]>; stop: () => void } {
  const list: Array<[number, number]> = [];
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (list.length < 4096) list.push([e.startTime, e.duration]);
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch {
    obs = null; // unsupported: list stays empty
  }
  return { list, stop: () => obs?.disconnect() };
}

export const SENDER_COLS = [
  'firstFrame',
  'frames',
  /** Block's last captured frame on the host render clock. */
  'blockEndHA',
  /** Block arrived on the host page thread from the capture worklet. */
  'captureH',
  /** HA -> H offset (ContextClockMap) at that moment. */
  'mapOffsetHA',
  'admitted',
  'encodeQueueBlocks',
  'sendQueueBlocks',
  'oldestQueuedMs',
  'encodedH',
  'encodeBusyMs',
  'sendCallH',
  'sendDoneH',
  'sendQueueAtCall',
  /** ServerClock offset (server = H + offset) and its ± uncertainty. */
  'serverOffsetH',
  'serverUncMs',
] as const;
export type SenderCol = (typeof SENDER_COLS)[number];

export const RECEIVER_COLS = [
  'firstFrame',
  'frames',
  /** Message delivered to the listener page thread. */
  'receiveL',
  'accepted',
  'decodeQueueBlocks',
  'decodedL',
  'decodeBusyMs',
  /** PCM posted to the playback worklet. */
  'postL',
  /** LA -> L offset (ContextClockMap) at post time. */
  'mapOffsetLA',
  /** Worklet received the block (render clock). */
  'arriveLA',
  /** Block's first frame rendered by the worklet; NaN if it never played (reset/trim). */
  'playLA',
  'bufferFramesAtArrive',
  'targetFrames',
  'serverOffsetL',
  'serverUncMs',
] as const;
export type ReceiverCol = (typeof RECEIVER_COLS)[number];

interface TraceMeta {
  timeOrigin: number;
  sampleRate?: number;
  baseLatency?: number;
  outputLatency?: number;
}

abstract class SideTrace<C extends string> {
  readonly table: TraceTable<C>;
  readonly map = new ContextClockMap();
  readonly meta: TraceMeta = { timeOrigin: performance.timeOrigin };
  private readonly longTasks = observeLongTasks();

  constructor(
    cols: readonly C[],
    private readonly clock: () => ClockEstimate | undefined,
  ) {
    this.table = new TraceTable(cols);
  }

  protected server(): { offset: number; unc: number } {
    const c = this.clock();
    return { offset: c ? c.offset : NaN, unc: c ? c.uncertainty : NaN };
  }

  noteContext(ctx: AudioContext): void {
    this.meta.sampleRate = ctx.sampleRate;
    this.meta.baseLatency = ctx.baseLatency;
    this.meta.outputLatency = ctx.outputLatency;
  }

  dump() {
    return { ...this.table.dump(), meta: { ...this.meta }, longTasks: this.longTasks.list.slice() };
  }

  dispose(): void {
    this.longTasks.stop();
  }
}

export class SenderTrace extends SideTrace<SenderCol> {
  constructor(clock: () => ClockEstimate | undefined) {
    super(SENDER_COLS, clock);
  }

  captured(
    seq: number,
    ctx: AudioContext,
    firstFrame: number,
    frames: number,
    queues: { encode: number; send: number; oldestMs: number },
  ): void {
    const now = performance.now();
    this.map.sample(ctx, now);
    const t = this.table;
    t.set(seq, 'firstFrame', firstFrame);
    t.set(seq, 'frames', frames);
    t.set(seq, 'blockEndHA', ((firstFrame + frames) / ctx.sampleRate) * 1000);
    t.set(seq, 'captureH', now);
    t.set(seq, 'mapOffsetHA', this.map.offset);
    t.set(seq, 'encodeQueueBlocks', queues.encode);
    t.set(seq, 'sendQueueBlocks', queues.send);
    t.set(seq, 'oldestQueuedMs', queues.oldestMs);
  }

  admitted(seq: number, ok: boolean): void {
    this.table.set(seq, 'admitted', ok ? 1 : 0);
  }

  encoded(seq: number, busyMs: number): void {
    this.table.set(seq, 'encodedH', performance.now());
    this.table.set(seq, 'encodeBusyMs', busyMs);
  }

  sendCall(seq: number, sendQueue: number): void {
    const s = this.server();
    this.table.set(seq, 'sendCallH', performance.now());
    this.table.set(seq, 'sendQueueAtCall', sendQueue);
    this.table.set(seq, 'serverOffsetH', s.offset);
    this.table.set(seq, 'serverUncMs', s.unc);
  }

  sendDone(seq: number): void {
    this.table.set(seq, 'sendDoneH', performance.now());
  }
}

export class ReceiverTrace extends SideTrace<ReceiverCol> {
  constructor(clock: () => ClockEstimate | undefined) {
    super(RECEIVER_COLS, clock);
  }

  received(seq: number, firstFrame: number, frames: number): void {
    const s = this.server();
    const t = this.table;
    // A block can be re-pushed after the playback graph is rebuilt: keep the first arrival.
    t.setOnce(seq, 'receiveL', performance.now());
    t.setOnce(seq, 'firstFrame', firstFrame);
    t.setOnce(seq, 'frames', frames);
    t.setOnce(seq, 'serverOffsetL', s.offset);
    t.setOnce(seq, 'serverUncMs', s.unc);
  }

  accepted(seq: number, ok: boolean, decodeQueue: number): void {
    this.table.set(seq, 'accepted', ok ? 1 : 0);
    this.table.set(seq, 'decodeQueueBlocks', decodeQueue);
  }

  decoded(seq: number, busyMs: number, ctx: AudioContext | null): void {
    const now = performance.now();
    this.table.set(seq, 'decodedL', now);
    this.table.set(seq, 'decodeBusyMs', busyMs);
    this.table.set(seq, 'postL', now);
    if (ctx) {
      this.map.sample(ctx, now);
      this.table.set(seq, 'mapOffsetLA', this.map.offset);
    }
  }

  /** Worklet report: [seq, arriveLA, playLA, bufferFrames, targetFrames] * n (render-clock ms). */
  worklet(items: Float64Array): void {
    for (let i = 0; i + 4 < items.length; i += 5) {
      const seq = items[i]!;
      this.table.set(seq, 'arriveLA', items[i + 1]!);
      this.table.set(seq, 'playLA', items[i + 2]!);
      this.table.set(seq, 'bufferFramesAtArrive', items[i + 3]!);
      this.table.set(seq, 'targetFrames', items[i + 4]!);
    }
  }
}

/** Test/diagnostic access: window.__mcLatency.{host,listener}.dump(). */
export function exposeTrace(side: 'host' | 'listener', trace: SenderTrace | ReceiverTrace): void {
  const g = globalThis as unknown as { __mcLatency?: Record<string, unknown> };
  g.__mcLatency ??= {};
  g.__mcLatency[side] = trace;
}
