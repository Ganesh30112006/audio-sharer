import playbackWorkletUrl from './playbackWorklet.ts?worker&url';
import { Emitter } from '../../utils/emitter';
import { createStore, type Store } from '../../utils/store';
import { peekHeader, type BlockHeader } from './codec';
import { CodecClient } from './codecClient';
import type { CodecReply } from './codecWorker';
import type { ReceiverTrace } from './latencyTrace';
import { ReceivePipeline } from './pipeline';

export interface LosslessReceiverStats {
  active: boolean;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  kbps: number;
  bufferMs: number;
  /** Current playback-buffer target (adaptive in auto mode) and the jitter it covers. */
  targetMs: number;
  jitterMs: number;
  /** Long-term memory of recent stalls the target still covers. */
  stallMemoryMs: number;
  bufferAdaptations: number;
  /** Audible outages: playback stopped for lack of data (incl. resets at gaps). */
  outages: number;
  outageMs: number;
  /** Time from the last outage start until audio played again. */
  lastRecoveryMs: number | null;
  clockCorrections: number;
  resyncs: number;
  /**
   * Frames delivered (accepted), decoded, and played. playedFrames counts each
   * decoded frame once when output; repeatedFrames are extra outputs of an
   * already-played frame (clock correction). decoded = played + skipped + buffered.
   */
  deliveredFrames: number;
  decodedFrames: number;
  playedFrames: number;
  /** Silence the playback buffer had to output after starting (underruns). */
  silenceFrames: number;
  /** Buffered frames discarded at a discontinuity reset or resync, and single-frame clock corrections. */
  skippedFrames: number;
  repeatedFrames: number;
  /** Frames currently waiting in the playback buffer. */
  bufferedFrames: number;
  /** Gaps the sender announced (its interruptions). */
  announcedGaps: number;
  /** Gaps without announcement — should stay 0 on the reliable channel. */
  unexpectedGaps: number;
  duplicates: number;
  stale: number;
  corrupt: number;
  /** Receiver-side interruptions (decoder overload). */
  interruptions: number;
  droppedFrames: number;
  decodeQueueBlocks: number;
  peakDecodeQueueBlocks: number;
  /** Capture -> arrival on the shared server clock (includes clock-sync error). */
  transitMs: number | null;
  decoderUtilization: number;
  offMainThread: boolean;
  /** Why playback can't start (e.g. the playback worklet failed to load); null when fine. */
  error: string | null;
}

/**
 * Playback buffer per mode: `auto` starts small and adapts to measured jitter
 * (never below `autoMin`); `stable` is a fixed, generous buffer.
 */
export const LOSSLESS_TARGET_MS = { auto: 40, stable: 300 } as const;
export const LOSSLESS_MIN_TARGET_MS = 20;
const STATS_INTERVAL_MS = 500;
/** After a failed playback-graph build, wait this long before trying again. */
const BUILD_RETRY_MS = 2000;
/** Packets held while the playback graph is being built. */
const MAX_PENDING = 100;

interface Format {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

const idle = (): LosslessReceiverStats => ({
  active: false,
  sampleRate: 0,
  bitDepth: 0,
  channels: 0,
  kbps: 0,
  bufferMs: 0,
  targetMs: 0,
  jitterMs: 0,
  stallMemoryMs: 0,
  bufferAdaptations: 0,
  outages: 0,
  outageMs: 0,
  lastRecoveryMs: null,
  clockCorrections: 0,
  resyncs: 0,
  deliveredFrames: 0,
  decodedFrames: 0,
  playedFrames: 0,
  silenceFrames: 0,
  skippedFrames: 0,
  repeatedFrames: 0,
  bufferedFrames: 0,
  announcedGaps: 0,
  unexpectedGaps: 0,
  duplicates: 0,
  stale: 0,
  corrupt: 0,
  interruptions: 0,
  droppedFrames: 0,
  decodeQueueBlocks: 0,
  peakDecodeQueueBlocks: 0,
  transitMs: null,
  decoderUtilization: 0,
  offMainThread: false,
  error: null,
});

/**
 * Receives lossless blocks: sequence checks and bounded decode queue
 * (ReceivePipeline), decoding in a worker, and playback through a jitter-
 * buffer worklet whose output is a MediaStream (so it can be routed to one or
 * more output devices). The AudioContext runs at the stream's own sample rate.
 */
export class LosslessReceiver {
  readonly stats: Store<LosslessReceiverStats> = createStore<LosslessReceiverStats>(idle());
  readonly events = new Emitter<{ stream: MediaStream | null }>();
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private format: Format | null = null;
  private building: Promise<void> | null = null;
  private pending: Uint8Array[] = [];
  private targetMs: number = LOSSLESS_TARGET_MS.auto;
  private adaptive = true;
  private disposed = false;
  private readonly codec = new CodecClient((reply) => this.onReply(reply));
  private readonly pipeline: ReceivePipeline;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private bytes = 0;
  private busyMs = 0;
  private last = { t: performance.now(), bytes: 0, busy: 0 };
  private outageStart: number | null = null;
  private playedOnce = false;
  private outageTotals = { count: 0, ms: 0, lastRecovery: null as number | null };
  private deliveredFrames = 0;
  private decodedFrames = 0;
  /** Frames that arrived while no playback graph could take them (counted, never silent). */
  private unavailableFrames = 0;
  private buildFailedAt: number | null = null;

  /**
   * @param observer optional read-only tap on each decoded block before
   *   playback (diagnostics, visualisers, integration tests). Must not mutate.
   */
  constructor(
    serverNow: () => number,
    private readonly observer?: (meta: BlockHeader, pcm: Float32Array) => void,
    /** Optional per-block latency trace (benchmarks/diagnostics). */
    private readonly trace: ReceiverTrace | null = null,
  ) {
    this.pipeline = new ReceivePipeline({
      now: () => performance.now(),
      serverNow,
      peek: peekHeader,
      decode: (job) =>
        this.codec.post({ op: 'decode', gen: job.gen, seq: job.meta.seq, payload: job.payload }, [
          job.payload.buffer,
        ]),
    });
  }

  /** Full flow-control counters (diagnostics and integration tests). */
  pipelineStats() {
    return this.pipeline.stats();
  }

  /** Sets the playback buffer; `adaptive` lets it follow measured jitter from there. */
  setTargetMs(ms: number, adaptive = false): void {
    this.targetMs = ms;
    this.adaptive = adaptive;
    this.node?.port.postMessage({ type: 'target', targetMs: ms, adaptive });
  }

  push(payload: Uint8Array): void {
    if (this.disposed) return;
    if (this.trace) {
      try {
        const h = peekHeader(payload);
        this.trace.received(h.seq, h.firstFrame, h.frames);
      } catch {
        // corrupt: counted by the pipeline below
      }
    }
    let meta;
    try {
      meta = peekHeader(payload);
    } catch {
      this.pipeline.receive(payload); // counts it as corrupt
      return;
    }
    if (this.building) {
      // Bounded while the playback graph is (re)built for a new format.
      if (this.pending.length < MAX_PENDING) this.pending.push(payload.slice());
      else this.unavailableFrames += meta.frames;
      return;
    }
    const f = this.format;
    if (
      !f &&
      this.buildFailedAt !== null &&
      performance.now() - this.buildFailedAt < BUILD_RETRY_MS
    ) {
      // The last build failed: back off instead of retrying on every packet.
      this.unavailableFrames += meta.frames;
      return;
    }
    if (
      !f ||
      f.sampleRate !== meta.sampleRate ||
      f.channels !== meta.channels ||
      f.bitDepth !== meta.bitDepth
    ) {
      this.pending.push(payload.slice());
      this.building = this.build(meta)
        .then(
          () => {
            this.buildFailedAt = null;
            this.stats.set({ error: null });
          },
          (err: unknown) => {
            this.buildFailedAt = performance.now();
            this.stats.set({ active: false, error: (err as Error)?.message ?? String(err) });
            // The previous graph (if any) is gone: players must drop its stream.
            this.events.emit('stream', null);
          },
        )
        .finally(() => {
          this.building = null;
          const queued = this.pending;
          this.pending = [];
          if (this.buildFailedAt === null) queued.forEach((p) => this.push(p));
          else
            for (const p of queued) {
              try {
                this.unavailableFrames += peekHeader(p).frames;
              } catch {
                // corrupt payloads were never playable
              }
            }
          this.publish();
        });
      return;
    }
    const accepted = this.pipeline.receive(payload);
    this.trace?.accepted(meta.seq, !!accepted, this.pipeline.decodeQ.size);
    if (accepted) {
      this.bytes += payload.length;
      this.deliveredFrames += accepted.frames;
    }
    this.statsTimer ??= setInterval(() => this.publish(), STATS_INTERVAL_MS);
  }

  private onReply(reply: CodecReply): void {
    this.busyMs += reply.busyMs;
    if (reply.op === 'error') {
      this.pipeline.decodeFailed(reply.gen, reply.seq);
      return;
    }
    if (reply.op !== 'decoded') return;
    const job = this.pipeline.decoded(reply.gen, reply.seq);
    if (!job || !this.node) return; // stale generation or torn down
    const f = this.format;
    if (!f || f.sampleRate !== reply.sampleRate || f.channels !== reply.channels) return;
    this.decodedFrames += job.meta.frames;
    this.observer?.(job.meta, reply.pcm);
    this.trace?.decoded(job.meta.seq, reply.busyMs, this.ctx);
    if (job.resetBefore) this.node.port.postMessage({ type: 'reset' });
    if (job.timingReset && this.outageStart !== null) {
      // The silence since the last block was the host pausing, not an outage.
      this.outageStart = null;
    }
    this.node.port.postMessage(
      { type: 'pcm', pcm: reply.pcm, seq: job.meta.seq, timing: job.timingReset || undefined },
      [reply.pcm.buffer],
    );
  }

  private onWorklet(
    msg: { type: string; playing?: boolean; adaptations?: number } & Partial<LosslessReceiverStats>,
  ): void {
    if (msg.type === 'state') {
      const now = performance.now();
      if (msg.playing) {
        if (this.outageStart !== null && this.playedOnce) {
          const ms = now - this.outageStart;
          this.outageTotals.count++;
          this.outageTotals.ms += ms;
          this.outageTotals.lastRecovery = Math.round(ms);
        }
        this.outageStart = null;
        this.playedOnce = true;
      } else if (this.outageStart === null) {
        this.outageStart = now;
      }
      this.publish();
    } else if (msg.type === 'trace') {
      this.trace?.worklet((msg as unknown as { items: Float64Array }).items);
    } else if (msg.type === 'stats') {
      this.stats.set({
        bufferMs: Math.round(msg.bufferMs ?? 0),
        targetMs: Math.round(msg.targetMs ?? 0),
        jitterMs: +(msg.jitterMs ?? 0).toFixed(1),
        stallMemoryMs: Math.round(msg.stallMemoryMs ?? 0),
        bufferAdaptations: msg.adaptations ?? 0,
        clockCorrections: msg.clockCorrections ?? 0,
        resyncs: msg.resyncs ?? 0,
        playedFrames: msg.playedFrames ?? 0,
        silenceFrames: msg.silenceFrames ?? 0,
        skippedFrames: msg.skippedFrames ?? 0,
        repeatedFrames: msg.repeatedFrames ?? 0,
        bufferedFrames: msg.bufferedFrames ?? 0,
      });
    }
  }

  private publish(): void {
    const s = this.pipeline.stats();
    const now = performance.now();
    const dt = Math.max(1, now - this.last.t);
    const kbps = Math.round(((this.bytes - this.last.bytes) * 8) / dt);
    const util = +((this.busyMs - this.last.busy) / dt).toFixed(3);
    this.last = { t: now, bytes: this.bytes, busy: this.busyMs };
    const ongoing = this.outageStart !== null && this.playedOnce ? now - this.outageStart : 0;
    this.stats.set({
      kbps,
      outages: this.outageTotals.count + (ongoing ? 1 : 0),
      outageMs: Math.round(this.outageTotals.ms + ongoing),
      lastRecoveryMs: this.outageTotals.lastRecovery,
      deliveredFrames: this.deliveredFrames,
      decodedFrames: this.decodedFrames,
      announcedGaps: s.announcedGaps,
      unexpectedGaps: s.unexpectedGaps,
      duplicates: s.duplicates,
      stale: s.stale,
      corrupt: s.corrupt,
      interruptions: s.interruptions,
      droppedFrames: s.droppedFrames + this.unavailableFrames,
      decodeQueueBlocks: s.decodeQueue.blocks,
      peakDecodeQueueBlocks: s.peakDecodeBlocks,
      transitMs: s.lastTransitMs,
      decoderUtilization: util,
      offMainThread: this.codec.offMainThread,
    });
  }

  private async build(first: Format): Promise<void> {
    this.teardown();
    // A new graph is a new playback timeline: decodes still in flight for the
    // old one become stale (ignored), and counters restart with the graph, so
    // decoded = played + skipped + buffered holds per graph.
    this.pipeline.reset();
    this.deliveredFrames = 0;
    this.decodedFrames = 0;
    const ctx = new AudioContext({ sampleRate: first.sampleRate, latencyHint: 'interactive' });
    try {
      await ctx.audioWorklet.addModule(playbackWorkletUrl);
    } catch (err) {
      void ctx.close().catch(() => undefined);
      throw err;
    }
    if (this.disposed) {
      void ctx.close();
      return;
    }
    const node = new AudioWorkletNode(ctx, 'mc-pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [first.channels],
      processorOptions: {
        channels: first.channels,
        targetMs: this.targetMs,
        maxMs: 1500,
        trace: !!this.trace,
        adaptive: this.adaptive,
        minMs: LOSSLESS_MIN_TARGET_MS,
      },
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = first.channels;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    node.connect(dest);
    node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data);
    this.ctx = ctx;
    this.node = node;
    this.trace?.noteContext(ctx);
    this.dest = dest;
    this.format = {
      sampleRate: first.sampleRate,
      channels: first.channels,
      bitDepth: first.bitDepth,
    };
    void ctx.resume();
    this.stats.set({ active: true, ...this.format, offMainThread: this.codec.offMainThread });
    this.events.emit('stream', dest.stream);
  }

  /** Call from a user gesture if the context was created while autoplay was blocked. */
  resume(): Promise<void> {
    return this.ctx?.resume() ?? Promise.resolve();
  }

  /** Host switched away from lossless: drop the graph. */
  stop(): void {
    if (!this.ctx) return;
    this.teardown();
    this.pipeline.reset();
    this.events.emit('stream', null);
    this.stats.set({ active: false, kbps: 0, bufferMs: 0 });
  }

  private teardown(): void {
    if (this.node) this.node.port.onmessage = null;
    this.node?.port.close();
    this.node?.disconnect();
    this.dest?.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.dest = null;
    this.format = null;
    this.outageStart = null;
    this.playedOnce = false;
  }

  dispose(): void {
    this.disposed = true;
    this.pending = [];
    this.teardown();
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.codec.dispose();
    this.events.clear();
  }
}
