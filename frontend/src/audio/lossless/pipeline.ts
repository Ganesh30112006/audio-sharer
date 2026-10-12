/**
 * Flow control for the lossless stream, independent of Web Audio, workers and
 * the network so it can be tested deterministically.
 *
 * Sender:   capture -> [encode queue] -> codec worker -> [send queue] -> SFU
 * Receiver: SFU -> sequence checks -> [decode queue] -> codec worker -> playback
 *
 * Contract: every captured block is either delivered bit-exact or accounted
 * for in an explicit Interruption. Blocks are never dropped silently; the
 * first block after an interruption carries the discontinuity flag, and the
 * receiver resets playback cleanly instead of splicing across the gap.
 */
import type { BlockHeader, PcmBlock } from './codec';
import {
  BoundedQueue,
  InterruptionLog,
  type Interruption,
  type QueueLimits,
  type QueueSnapshot,
} from './flowControl';

/**
 * ~1 s of 10 ms blocks, 2 MB, 750 ms age: bounded latency before declaring an
 * interruption. The age limit is the one that normally trips first.
 */
export const DEFAULT_SEND_LIMITS = {
  encode: { maxBlocks: 100, maxBytes: 2 * 1024 * 1024, maxAgeMs: 750, resumeFraction: 0.25 },
  send: { maxBlocks: 100, maxBytes: 2 * 1024 * 1024, maxAgeMs: 750, resumeFraction: 0.25 },
} satisfies Record<string, QueueLimits>;

export const DEFAULT_RECEIVE_LIMITS: QueueLimits = {
  maxBlocks: 100,
  maxBytes: 2 * 1024 * 1024,
  maxAgeMs: 750,
  resumeFraction: 0.25,
};

/** Signed distance a - b for 32-bit wrapping counters. */
export const seqDiff = (a: number, b: number) => (a - b) | 0;

export interface EncodeJob {
  gen: number;
  block: PcmBlock;
}

export interface SendStats {
  state: 'streaming' | 'interrupted';
  encodeQueue: QueueSnapshot;
  sendQueue: QueueSnapshot;
  peakEncodeBlocks: number;
  peakSendBlocks: number;
  peakSendBytes: number;
  peakOldestAgeMs: number;
  blocksCaptured: number;
  capturedFrames: number;
  /** Timeline frames never captured (engine skipped the capture stage). */
  captureGapFrames: number;
  encodedFrames: number;
  /** Frames in blocks the transport accepted. */
  sentFrames: number;
  blocksSent: number;
  bytesSent: number;
  rawBytesSent: number;
  interruptions: number;
  interruptedMs: number;
  droppedFrames: number;
  transportErrors: number;
  current: Interruption | null;
  recent: readonly Interruption[];
}

export class SendPipeline {
  readonly encodeQ: BoundedQueue;
  readonly sendQ: BoundedQueue;
  readonly log: InterruptionLog;
  private gen = 1;
  private seq = 0;
  private frame = 0;
  private discontinuityNext = false;
  private timingResetNext = false;
  /** Last seq admitted to the encode queue. */
  private lastAdmitted: number | null = null;
  /**
   * A network interruption claims every block already in flight up to here:
   * they are dropped even if encoding finishes after the interruption ends, so
   * the delivered sequence is "...before | gap | flagged block" with nothing
   * stale arriving after the gap.
   */
  private dropThrough: number | null = null;
  private blocksCaptured = 0;
  private capturedFrames = 0;
  private captureGapFrames = 0;
  private encodedFrames = 0;
  private sentFrames = 0;
  private blocksSent = 0;
  private bytesSent = 0;
  private rawBytesSent = 0;
  private transportErrors = 0;
  /** Raw size and frame count per in-flight block (for accounting). */
  private inflight = new Map<number, { raw: number; frames: number }>();

  constructor(
    private readonly io: {
      now: () => number;
      serverNow: () => number;
      encode: (job: EncodeJob) => void;
      send: (payload: Uint8Array<ArrayBuffer>) => Promise<void>;
      /**
       * False while the transport can't take data (reconnecting, disconnected).
       * Blocks captured meanwhile are counted in one open 'transport-error'
       * interruption, and the first block after it is flagged.
       */
      canSend?: () => boolean;
    },
    limits = DEFAULT_SEND_LIMITS,
  ) {
    this.encodeQ = new BoundedQueue(limits.encode, io.now);
    this.sendQ = new BoundedQueue(limits.send, io.now);
    this.log = new InterruptionLog(io.now);
  }

  get generation(): number {
    return this.gen;
  }

  /**
   * The source paused (its audio graph was suspended): samples are contiguous
   * but wall time jumped. The next admitted block carries a timing reset so
   * listeners restart their jitter tracking instead of reading the pause as
   * network delay. Nothing is flushed, because nothing is missing.
   */
  markTimingReset(): void {
    this.timingResetNext = true;
  }

  /** Sequence number the next captured block will get (latency trace). */
  get nextSeq(): number {
    return this.seq;
  }

  /** Last sequence number admitted to the encode queue (latency trace). */
  get lastAdmittedSeq(): number | null {
    return this.lastAdmitted;
  }

  /**
   * Called for every captured block. Never blocks: either admits the block to
   * the encode queue or accounts for it in the current interruption.
   */
  /**
   * @param firstFrame stream position of the block's first frame. Pass the
   *   AudioContext frame clock so gaps in capture (restarts) are visible as
   *   position jumps; defaults to a contiguous counter.
   */
  capture(
    samples: Int32Array,
    channels: number,
    sampleRate: number,
    bitDepth: number,
    firstFrame = this.frame,
    /** Timeline frames the capture stage never saw right before this block. */
    gapBefore = 0,
  ): void {
    const frames = samples.length / channels;
    const seq = this.seq;
    if (gapBefore > 0) {
      // Audio that was never captured is an interruption, recorded explicitly.
      this.captureGapFrames += gapBefore;
      if (this.log.current) this.log.drop(gapBefore);
      else {
        this.log.begin('capture-gap', null);
        this.log.drop(gapBefore);
        this.log.end();
        this.discontinuityNext = true;
      }
    }
    this.seq = (this.seq + 1) >>> 0;
    this.frame = (firstFrame + frames) >>> 0;
    this.blocksCaptured++;
    this.capturedFrames += frames;

    const transportUp = this.io.canSend?.() ?? true;
    if (this.log.current) {
      if (transportUp && this.encodeQ.belowResume() && this.sendQ.belowResume()) {
        this.log.end();
        this.discontinuityNext = true;
      } else {
        this.log.drop(frames);
        return;
      }
    }
    if (!transportUp) {
      this.log.begin('transport-error', null);
      // Blocks still being encoded can't be delivered either.
      this.dropThrough = this.lastAdmitted;
      this.log.drop(frames);
      return;
    }
    const enc = this.encodeQ.overLimit();
    // Everything being encoded is headed for the send queue: count it there
    // too, so the send queue's block limit is a hard bound.
    const net =
      this.sendQ.overLimit() ??
      (this.sendQ.size + this.encodeQ.size >= this.sendQ.limits.maxBlocks ? 'blocks' : null);
    if (enc || net) {
      const cause = enc ? 'encoder-overload' : 'network-congestion';
      this.log.begin(cause, enc ?? net);
      if (cause === 'network-congestion') this.dropThrough = this.lastAdmitted;
      this.log.drop(frames);
      return;
    }

    const rawBytes = (samples.length * bitDepth) / 8;
    this.encodeQ.push(seq, rawBytes);
    this.lastAdmitted = seq;
    this.inflight.set(seq, { raw: rawBytes, frames });
    this.io.encode({
      gen: this.gen,
      block: {
        seq,
        sampleRate,
        channels,
        bitDepth,
        samples,
        firstFrame,
        captureMs: this.io.serverNow() >>> 0,
        discontinuity: this.discontinuityNext,
        timingReset: this.timingResetNext,
      },
    });
    this.discontinuityNext = false;
    this.timingResetNext = false;
  }

  /**
   * A block from a capture generation that is no longer active (e.g. the
   * final partial block flushed after stop(), or a stale producer). It was
   * captured, so it is counted — and it is refused with an explicit record.
   */
  rejectCapture(
    frames: number,
    generation: number,
    firstFrame: number,
    cause: 'session-reset' | 'stale-capture',
  ): void {
    this.blocksCaptured++;
    this.capturedFrames += frames;
    const wasOpen = !!this.log.current;
    const rec = this.log.begin(cause, null);
    if (!wasOpen) rec.detail = { generation, firstFrame, frames };
    this.log.drop(frames);
    if (!wasOpen) this.log.end();
  }

  /** Encoded block back from the worker (strictly in submission order). */
  encoded(gen: number, seq: number, payload: Uint8Array<ArrayBuffer>): void {
    if (gen !== this.gen) return; // stale reply from a previous session
    this.encodeQ.shift();
    const info = this.inflight.get(seq);
    this.inflight.delete(seq);
    const raw = info?.raw ?? 0;
    this.encodedFrames += info?.frames ?? 0;
    if (this.dropThrough !== null && seqDiff(seq, this.dropThrough) <= 0) {
      // Claimed by a network interruption: part of the announced gap.
      this.log.dropUnattributed(info?.frames ?? 0);
      if (seq === this.dropThrough) this.dropThrough = null;
      return;
    }
    this.sendQ.push(seq, payload.length);
    this.io.send(payload).then(
      () => {
        this.sendQ.remove(seq);
        this.blocksSent++;
        this.sentFrames += info?.frames ?? 0;
        this.bytesSent += payload.length;
        this.rawBytesSent += raw;
      },
      () => {
        this.sendQ.remove(seq);
        this.transportErrors++;
        if (!this.log.current) {
          this.log.begin('transport-error', null);
          this.dropThrough = this.lastAdmitted;
        }
        this.log.dropUnattributed(info?.frames ?? 0);
      },
    );
  }

  /** Encoder failure for a block: it can't be delivered, so it opens an interruption. */
  encodeFailed(gen: number, seq: number): void {
    if (gen !== this.gen) return;
    this.encodeQ.shift();
    const info = this.inflight.get(seq);
    this.inflight.delete(seq);
    const wasOpen = !!this.log.current;
    this.log.begin('encoder-overload', null);
    // Blocks queued behind the failed one were encoded without a discontinuity
    // flag: they are claimed by this interruption, so the first block the
    // receiver sees after the gap is the flagged one.
    if (!wasOpen) this.dropThrough = this.lastAdmitted;
    this.log.drop(info?.frames ?? 0);
  }

  /** Stop/restart: invalidates in-flight work so stale replies are ignored. */
  reset(): void {
    // Blocks still being encoded are abandoned with the old generation:
    // account for them explicitly instead of letting them vanish.
    if (this.inflight.size) {
      if (!this.log.current) this.log.begin('session-reset', null);
      for (const { frames } of this.inflight.values()) this.log.drop(frames);
    }
    this.gen++;
    this.encodeQ.clear();
    this.sendQ.clear();
    this.inflight.clear();
    this.dropThrough = null;
    this.lastAdmitted = null;
    if (this.log.current) this.log.end();
    this.discontinuityNext = true;
  }

  stats(): SendStats {
    return {
      state: this.log.current ? 'interrupted' : 'streaming',
      encodeQueue: this.encodeQ.snapshot(),
      sendQueue: this.sendQ.snapshot(),
      peakEncodeBlocks: this.encodeQ.peak.blocks,
      peakSendBlocks: this.sendQ.peak.blocks,
      peakSendBytes: this.sendQ.peak.bytes,
      peakOldestAgeMs: Math.max(this.encodeQ.peak.oldestAgeMs, this.sendQ.peak.oldestAgeMs),
      blocksCaptured: this.blocksCaptured,
      capturedFrames: this.capturedFrames,
      captureGapFrames: this.captureGapFrames,
      encodedFrames: this.encodedFrames,
      sentFrames: this.sentFrames,
      blocksSent: this.blocksSent,
      bytesSent: this.bytesSent,
      rawBytesSent: this.rawBytesSent,
      interruptions: this.log.total,
      interruptedMs:
        this.log.totalMs + (this.log.current ? this.io.now() - this.log.current.startedAt : 0),
      droppedFrames: this.log.totalDroppedFrames,
      transportErrors: this.transportErrors,
      current: this.log.current,
      recent: this.log.recent,
    };
  }
}

export interface DecodeJob {
  gen: number;
  payload: Uint8Array<ArrayBuffer>;
  meta: BlockHeader;
  /** Playback must flush and re-buffer before this block (gap upstream or here). */
  resetBefore: boolean;
  /** The source paused before this block: restart jitter tracking (no flush). */
  timingReset: boolean;
}

export interface ReceiveStats {
  state: 'receiving' | 'interrupted';
  decodeQueue: QueueSnapshot;
  peakDecodeBlocks: number;
  peakOldestAgeMs: number;
  blocksReceived: number;
  blocksDecoded: number;
  duplicates: number;
  stale: number;
  /** Gaps announced by the sender (its interruptions). */
  announcedGaps: number;
  /** Gaps without a discontinuity flag — should stay 0 on a reliable channel. */
  unexpectedGaps: number;
  corrupt: number;
  interruptions: number;
  interruptedMs: number;
  droppedFrames: number;
  /** Capture -> arrival delay on the shared server clock (ms), last and max. */
  lastTransitMs: number | null;
  maxTransitMs: number | null;
}

export class ReceivePipeline {
  readonly decodeQ: BoundedQueue;
  readonly log: InterruptionLog;
  private gen = 1;
  private lastSeq: number | null = null;
  private expectedFrame: number | null = null;
  private resetNext = true;
  private counters = {
    received: 0,
    decoded: 0,
    duplicates: 0,
    stale: 0,
    announced: 0,
    unexpected: 0,
    corrupt: 0,
  };
  private lastTransit: number | null = null;
  private maxTransit: number | null = null;
  private pendingMeta = new Map<number, DecodeJob>();

  constructor(
    private readonly io: {
      now: () => number;
      serverNow: () => number;
      peek: (payload: Uint8Array) => BlockHeader;
      decode: (job: DecodeJob) => void;
    },
    limits: QueueLimits = DEFAULT_RECEIVE_LIMITS,
  ) {
    this.decodeQ = new BoundedQueue(limits, io.now);
    this.log = new InterruptionLog(io.now);
  }

  get generation(): number {
    return this.gen;
  }

  /** Returns the block header if accepted for decoding, null otherwise. */
  receive(payload: Uint8Array): BlockHeader | null {
    let meta: BlockHeader;
    try {
      meta = this.io.peek(payload);
    } catch {
      this.counters.corrupt++;
      return null;
    }
    this.counters.received++;

    if (this.lastSeq !== null) {
      const d = seqDiff(meta.seq, this.lastSeq);
      if (d === 0) {
        this.counters.duplicates++;
        return null;
      }
      if (d < 0) {
        this.counters.stale++;
        return null;
      }
      if (meta.discontinuity) this.counters.announced++;
      if (d > 1) {
        if (!meta.discontinuity) {
          this.counters.unexpected++;
          this.log.begin('upstream-gap', null);
          this.log.drop(
            this.expectedFrame !== null ? (meta.firstFrame - this.expectedFrame) >>> 0 : 0,
          );
          this.log.end();
        }
        this.resetNext = true;
      } else if (meta.discontinuity) {
        this.resetNext = true;
      } else if (this.expectedFrame !== null && meta.firstFrame !== this.expectedFrame) {
        // Contiguous seq but the sample position jumped without an announcement:
        // a protocol violation. Never splice across it.
        this.counters.unexpected++;
        this.log.begin('upstream-gap', null);
        this.log.drop((meta.firstFrame - this.expectedFrame) >>> 0);
        this.log.end();
        this.resetNext = true;
      }
    }
    this.lastSeq = meta.seq;
    this.expectedFrame = (meta.firstFrame + meta.frames) >>> 0;
    if (meta.captureMs) {
      const transit = seqDiff(this.io.serverNow() >>> 0, meta.captureMs);
      if (transit >= 0 && transit < 60_000) {
        this.lastTransit = transit;
        this.maxTransit = Math.max(this.maxTransit ?? 0, transit);
      }
    }

    if (this.log.current) {
      if (this.decodeQ.belowResume()) {
        this.log.end();
        this.resetNext = true;
      } else {
        this.log.drop(meta.frames);
        return null;
      }
    }
    const over = this.decodeQ.overLimit();
    if (over) {
      this.log.begin('decoder-overload', over);
      this.log.drop(meta.frames);
      return null;
    }

    const copy = payload.slice() as Uint8Array<ArrayBuffer>;
    const job: DecodeJob = {
      gen: this.gen,
      payload: copy,
      meta,
      resetBefore: this.resetNext,
      timingReset: meta.timingReset,
    };
    this.resetNext = false;
    this.decodeQ.push(meta.seq, payload.length);
    this.pendingMeta.set(meta.seq, job);
    this.io.decode(job);
    return meta;
  }

  /** A decode finished (in order). Returns the job so the caller knows whether to reset playback. */
  decoded(gen: number, seq: number): DecodeJob | null {
    if (gen !== this.gen) return null;
    this.decodeQ.shift();
    const job = this.pendingMeta.get(seq) ?? null;
    this.pendingMeta.delete(seq);
    if (job) this.counters.decoded++;
    return job;
  }

  decodeFailed(gen: number, seq: number): void {
    if (gen !== this.gen) return;
    this.decodeQ.shift();
    const job = this.pendingMeta.get(seq);
    this.pendingMeta.delete(seq);
    this.counters.corrupt++;
    this.resetNext = true;
    // The block can't be played: an explicit interruption, with its frames.
    const frames = job?.meta.frames ?? 0;
    if (this.log.current) this.log.drop(frames);
    else {
      this.log.begin('decode-error', null);
      this.log.drop(frames);
      this.log.end();
    }
  }

  reset(): void {
    this.gen++;
    this.decodeQ.clear();
    this.pendingMeta.clear();
    this.lastSeq = null;
    this.expectedFrame = null;
    this.resetNext = true;
    if (this.log.current) this.log.end();
  }

  stats(): ReceiveStats {
    const c = this.counters;
    return {
      state: this.log.current ? 'interrupted' : 'receiving',
      decodeQueue: this.decodeQ.snapshot(),
      peakDecodeBlocks: this.decodeQ.peak.blocks,
      peakOldestAgeMs: this.decodeQ.peak.oldestAgeMs,
      blocksReceived: c.received,
      blocksDecoded: c.decoded,
      duplicates: c.duplicates,
      stale: c.stale,
      announcedGaps: c.announced,
      unexpectedGaps: c.unexpected,
      corrupt: c.corrupt,
      interruptions: this.log.total,
      interruptedMs:
        this.log.totalMs + (this.log.current ? this.io.now() - this.log.current.startedAt : 0),
      droppedFrames: this.log.totalDroppedFrames,
      lastTransitMs: this.lastTransit,
      maxTransitMs: this.maxTransit,
    };
  }
}
