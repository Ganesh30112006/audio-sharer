import captureWorkletUrl from './captureWorklet.ts?worker&url';
import { createStore, type Store } from '../../utils/store';
import type { CapturedBlock } from './captureAssembler';
import { CaptureLifecycle, type CaptureNodeHandle } from './captureLifecycle';
import { CodecClient } from './codecClient';
import type { CodecReply } from './codecWorker';
import type { Interruption } from './flowControl';
import { SendPipeline } from './pipeline';

/** Target block duration. */
const BLOCK_MS = 20;
/**
 * Cap on a block's raw size so one encoded block always fits a single reliable
 * data-channel message (LiveKit recommends < 15 KiB). Hi-res streams therefore
 * use shorter blocks: 24-bit/192 kHz stereo -> 2000 frames (~10 ms).
 */
const MAX_RAW_BLOCK_BYTES = 12_000;
const STATS_INTERVAL_MS = 500;

export function blockFramesFor(sampleRate: number, bitDepth: number, channels = 2): number {
  const byDuration = Math.round((sampleRate * BLOCK_MS) / 1000);
  const bySize = Math.floor(MAX_RAW_BLOCK_BYTES / (channels * Math.ceil(bitDepth / 8)));
  return Math.max(64, Math.min(byDuration, bySize));
}

export interface LosslessSenderStats {
  active: boolean;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  /** Payload sent per second, kbit/s. */
  kbps: number;
  /** Encoded size / raw PCM size over the last interval. */
  ratio: number;
  state: 'streaming' | 'interrupted';
  /** Current interruption, if any — shown to the host, never hidden. */
  interruption: Interruption | null;
  interruptions: number;
  interruptedMs: number;
  droppedFrames: number;
  encodeQueueBlocks: number;
  sendQueueBlocks: number;
  sendQueueKB: number;
  oldestAgeMs: number;
  peakSendQueueBlocks: number;
  peakOldestAgeMs: number;
  /** Share of wall time the codec worker spent encoding. */
  encoderUtilization: number;
  offMainThread: boolean;
}

type Send = (payload: Uint8Array<ArrayBuffer>) => Promise<void>;

/** Capture-thread diagnostics: render quanta processed, context frames never seen by the worklet, inactive-input quanta. */
export interface CaptureDiag {
  quanta: number;
  unseenFrames: number;
  inactiveQuanta: number;
  layoutChanges: number;
}

const idle = (): LosslessSenderStats => ({
  active: false,
  sampleRate: 0,
  bitDepth: 0,
  channels: 0,
  kbps: 0,
  ratio: 1,
  state: 'streaming',
  interruption: null,
  interruptions: 0,
  interruptedMs: 0,
  droppedFrames: 0,
  encodeQueueBlocks: 0,
  sendQueueBlocks: 0,
  sendQueueKB: 0,
  oldestAgeMs: 0,
  peakSendQueueBlocks: 0,
  peakOldestAgeMs: 0,
  encoderUtilization: 0,
  offMainThread: false,
});

/**
 * Captures integer PCM from an AudioNode (via an AudioWorklet), compresses it
 * losslessly in a worker and sends it over the SFU's reliable, ordered data
 * channel. Flow control (bounded queues, explicit interruptions) lives in
 * SendPipeline; this class wires it to Web Audio, the worker and the network.
 */
export class LosslessSender {
  readonly stats: Store<LosslessSenderStats> = createStore<LosslessSenderStats>(idle());
  private readonly codec = new CodecClient((reply) => this.onReply(reply));
  private readonly pipeline: SendPipeline;
  private readonly capture: CaptureLifecycle<AudioContext>;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private last = { t: 0, bytes: 0, raw: 0, busy: 0 };
  private busyMs = 0;
  private format = { sampleRate: 0, bitDepth: 0, channels: 0 };
  /** Generation that was just stopped: its final flushed block is expected, not stale. */
  private lastStoppedGen = 0;
  captureDiag: CaptureDiag | null = null;
  private static modules = new WeakMap<BaseAudioContext, Promise<void>>();

  constructor(send: Send, serverNow: () => number) {
    this.pipeline = new SendPipeline({
      now: () => performance.now(),
      serverNow,
      encode: (job) =>
        this.codec.post({ op: 'encode', gen: job.gen, block: job.block }, [
          job.block.samples.buffer,
        ]),
      send,
    });
    this.capture = new CaptureLifecycle<AudioContext>(
      (ctx, onMessage) => LosslessSender.createNode(ctx, onMessage),
      (data, ctx) =>
        this.onCaptured(data as CapturedBlock & { gen: number; diag?: CaptureDiag }, ctx),
    );
  }

  /** One long-lived capture node per context (positions share one timeline). */
  private static async createNode(
    ctx: AudioContext,
    onMessage: (data: unknown) => void,
  ): Promise<CaptureNodeHandle> {
    let loaded = LosslessSender.modules.get(ctx);
    if (!loaded) {
      loaded = ctx.audioWorklet.addModule(captureWorkletUrl);
      LosslessSender.modules.set(ctx, loaded);
    }
    await loaded;
    const node = new AudioWorkletNode(ctx, 'mc-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: 'max',
      channelInterpretation: 'discrete',
    });
    // The node must reach the destination to be rendered; it outputs silence.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent) => onMessage(e.data);
    return {
      post: (msg) => node.port.postMessage(msg),
      connect: (source) => source.connect(node),
      disconnect: (source) => {
        try {
          source.disconnect(node);
        } catch {
          // already disconnected
        }
      },
      dispose: () => {
        node.port.onmessage = null;
        node.port.close();
        node.disconnect();
        sink.disconnect();
      },
    };
  }

  async start(ctx: AudioContext, source: AudioNode, bitDepth: number): Promise<void> {
    // Same graph and format: keep streaming without a gap.
    if (this.capture.isActive(ctx, source, bitDepth)) return;
    this.stop();
    this.capture.prune((c) => c.state === 'closed');
    const gen = await this.capture.start(
      ctx,
      source,
      bitDepth,
      blockFramesFor(ctx.sampleRate, bitDepth),
    );
    if (gen === null) return; // superseded by a later start()/stop()
    this.format = { sampleRate: ctx.sampleRate, bitDepth, channels: 0 };
    this.last = { t: performance.now(), bytes: 0, raw: 0, busy: 0 };
    this.statsTimer ??= setInterval(() => this.publish(), STATS_INTERVAL_MS);
    this.stats.set({
      active: true,
      sampleRate: ctx.sampleRate,
      bitDepth,
      offMainThread: this.codec.offMainThread,
    });
  }

  private onCaptured(
    data: CapturedBlock & { gen: number; diag?: CaptureDiag },
    ctx: AudioContext,
  ): void {
    if (data.diag) {
      this.captureDiag = data.diag;
      return;
    }
    const frames = data.samples.length / data.channels;
    // Pipeline boundary: only the active generation's blocks are admitted.
    if (data.gen !== this.capture.currentGeneration || ctx !== this.capture.activeContext) {
      this.pipeline.rejectCapture(
        frames,
        data.gen,
        data.frame,
        data.gen === this.lastStoppedGen ? 'session-reset' : 'stale-capture',
      );
      return;
    }
    this.format.channels = data.channels;
    const before = this.pipeline.log.current;
    this.pipeline.capture(
      data.samples,
      data.channels,
      ctx.sampleRate,
      this.format.bitDepth,
      data.frame,
      data.gapBefore,
    );
    if (this.pipeline.log.current !== before) this.publish(); // state change: report immediately
  }

  private onReply(reply: CodecReply): void {
    this.busyMs += reply.busyMs;
    if (reply.op === 'encoded') this.pipeline.encoded(reply.gen, reply.seq, reply.payload);
    else if (reply.op === 'error') this.pipeline.encodeFailed(reply.gen, reply.seq);
  }

  private publish(): void {
    const s = this.pipeline.stats();
    const now = performance.now();
    const dt = Math.max(1, now - this.last.t);
    const dBytes = s.bytesSent - this.last.bytes;
    const dRaw = s.rawBytesSent - this.last.raw;
    const dBusy = this.busyMs - this.last.busy;
    this.last = { t: now, bytes: s.bytesSent, raw: s.rawBytesSent, busy: this.busyMs };
    this.stats.set({
      channels: this.format.channels,
      kbps: Math.round((dBytes * 8) / dt),
      ratio: dRaw ? +(dBytes / dRaw).toFixed(3) : this.stats.get().ratio,
      state: s.state,
      interruption: s.current,
      interruptions: s.interruptions,
      interruptedMs: Math.round(s.interruptedMs),
      droppedFrames: s.droppedFrames,
      encodeQueueBlocks: s.encodeQueue.blocks,
      sendQueueBlocks: s.sendQueue.blocks,
      sendQueueKB: Math.round(s.sendQueue.bytes / 1024),
      oldestAgeMs: Math.round(Math.max(s.encodeQueue.oldestAgeMs, s.sendQueue.oldestAgeMs)),
      peakSendQueueBlocks: s.peakSendBlocks,
      peakOldestAgeMs: Math.round(s.peakOldestAgeMs),
      encoderUtilization: +(dBusy / dt).toFixed(3),
    });
  }

  /** Full flow-control counters (diagnostics and integration tests). */
  pipelineStats() {
    return this.pipeline.stats();
  }

  /** Stops the active capture generation and invalidates in-flight work (stale replies are ignored). */
  stop(): void {
    const gen = this.capture.currentGeneration;
    this.capture.stop(); // also cancels a start() still awaiting its node
    if (!gen) return;
    this.lastStoppedGen = gen;
    this.pipeline.reset();
    this.publish();
    this.stats.set({ active: false, kbps: 0 });
  }

  /** Forget a context's capture node (call before closing that context). */
  releaseContext(ctx: AudioContext): void {
    this.capture.forget(ctx);
  }

  /** Release the codec worker and capture nodes; the sender cannot be restarted afterwards. */
  dispose(): void {
    this.stop();
    void this.capture.dispose();
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.codec.dispose();
  }
}
