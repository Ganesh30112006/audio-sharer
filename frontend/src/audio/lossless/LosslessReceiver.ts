import playbackWorkletUrl from './playbackWorklet.ts?worker&url';
import { Emitter } from '../../utils/emitter';
import { createStore, type Store } from '../../utils/store';
import { peekHeader, type BlockHeader } from './codec';
import { CodecClient } from './codecClient';
import type { CodecReply } from './codecWorker';
import { ReceivePipeline } from './pipeline';

export interface LosslessReceiverStats {
  active: boolean;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  kbps: number;
  bufferMs: number;
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
}

export const LOSSLESS_TARGET_MS = { auto: 120, stable: 300 } as const;
const STATS_INTERVAL_MS = 500;

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

  /**
   * @param observer optional read-only tap on each decoded block before
   *   playback (diagnostics, visualisers, integration tests). Must not mutate.
   */
  constructor(
    serverNow: () => number,
    private readonly observer?: (meta: BlockHeader, pcm: Float32Array) => void,
  ) {
    this.pipeline = new ReceivePipeline({
      now: () => performance.now(),
      serverNow,
      peek: peekHeader,
      decode: (job) =>
        this.codec.post({ op: 'decode', gen: job.gen, seq: job.meta.seq, payload: job.payload }, [job.payload.buffer]),
    });
  }

  /** Full flow-control counters (diagnostics and integration tests). */
  pipelineStats() {
    return this.pipeline.stats();
  }

  setTargetMs(ms: number): void {
    this.targetMs = ms;
    this.node?.port.postMessage({ type: 'target', targetMs: ms });
  }

  push(payload: Uint8Array): void {
    if (this.disposed) return;
    if (this.building) {
      // Bounded while the playback graph is (re)built for a new format.
      if (this.pending.length < 100) this.pending.push(payload.slice());
      return;
    }
    let meta;
    try {
      meta = peekHeader(payload);
    } catch {
      this.pipeline.receive(payload); // counts it as corrupt
      return;
    }
    const f = this.format;
    if (!f || f.sampleRate !== meta.sampleRate || f.channels !== meta.channels || f.bitDepth !== meta.bitDepth) {
      this.pending.push(payload.slice());
      this.building = this.build(meta).finally(() => {
        this.building = null;
        const queued = this.pending;
        this.pending = [];
        queued.forEach((p) => this.push(p));
      });
      return;
    }
    const accepted = this.pipeline.receive(payload);
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
    if (job.resetBefore) this.node.port.postMessage({ type: 'reset' });
    this.node.port.postMessage({ type: 'pcm', pcm: reply.pcm }, [reply.pcm.buffer]);
  }

  private onWorklet(msg: { type: string; playing?: boolean } & Partial<LosslessReceiverStats>): void {
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
    } else if (msg.type === 'stats') {
      this.stats.set({
        bufferMs: Math.round(msg.bufferMs ?? 0),
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
      droppedFrames: s.droppedFrames,
      decodeQueueBlocks: s.decodeQueue.blocks,
      peakDecodeQueueBlocks: s.peakDecodeBlocks,
      transitMs: s.lastTransitMs,
      decoderUtilization: util,
    });
  }

  private async build(first: Format): Promise<void> {
    this.teardown();
    const ctx = new AudioContext({ sampleRate: first.sampleRate, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(playbackWorkletUrl);
    if (this.disposed) {
      void ctx.close();
      return;
    }
    const node = new AudioWorkletNode(ctx, 'mc-pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [first.channels],
      processorOptions: { channels: first.channels, targetMs: this.targetMs, windowMs: 40, maxMs: 1500 },
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = first.channels;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    node.connect(dest);
    node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data);
    this.ctx = ctx;
    this.node = node;
    this.dest = dest;
    this.format = { sampleRate: first.sampleRate, channels: first.channels, bitDepth: first.bitDepth };
    this.pipeline.reset(); // new stream format: fresh sequence tracking
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
