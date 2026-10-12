import playbackWorkletUrl from './playbackWorklet.ts?worker&url';
import { Emitter } from '../../utils/emitter';
import { createStore, type Store } from '../../utils/store';
import { CodecError, decodeBlock } from './codec';

export interface LosslessReceiverStats {
  active: boolean;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  kbps: number;
  bufferMs: number;
  underruns: number;
  clockCorrections: number;
  resyncs: number;
  /** Sequence gaps (should stay 0 on a reliable channel). */
  gaps: number;
  corrupt: number;
}

export const LOSSLESS_TARGET_MS = { auto: 120, stable: 300 } as const;

interface Format {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

/**
 * Decodes lossless blocks and plays them through a jitter-buffer worklet. The
 * output is exposed as a MediaStream so it can be routed to one or more
 * output devices like any other source. The AudioContext runs at the stream's
 * own sample rate, so samples are never resampled by the app.
 */
export class LosslessReceiver {
  readonly stats: Store<LosslessReceiverStats> = createStore<LosslessReceiverStats>({
    active: false,
    sampleRate: 0,
    bitDepth: 0,
    channels: 0,
    kbps: 0,
    bufferMs: 0,
    underruns: 0,
    clockCorrections: 0,
    resyncs: 0,
    gaps: 0,
    corrupt: 0,
  });
  readonly events = new Emitter<{ stream: MediaStream | null }>();
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private format: Format | null = null;
  private building: Promise<void> | null = null;
  private pending: Uint8Array[] = [];
  private lastSeq: number | null = null;
  private windowBytes = 0;
  private windowStart = performance.now();
  private targetMs: number = LOSSLESS_TARGET_MS.auto;
  private disposed = false;

  setTargetMs(ms: number): void {
    this.targetMs = ms;
    this.node?.port.postMessage({ type: 'target', targetMs: ms });
  }

  push(payload: Uint8Array): void {
    if (this.disposed) return;
    if (this.building) {
      this.pending.push(payload);
      return;
    }
    let block;
    try {
      block = decodeBlock(payload);
    } catch (err) {
      if (err instanceof CodecError) this.stats.set((s) => ({ corrupt: s.corrupt + 1 }));
      return;
    }
    const f = this.format;
    if (
      !f ||
      f.sampleRate !== block.sampleRate ||
      f.channels !== block.channels ||
      f.bitDepth !== block.bitDepth
    ) {
      this.pending.push(payload);
      this.building = this.build(block).finally(() => {
        this.building = null;
        const queued = this.pending;
        this.pending = [];
        queued.forEach((p) => this.push(p));
      });
      return;
    }
    if (this.lastSeq !== null && block.seq !== (this.lastSeq + 1) >>> 0 && block.seq !== 0) {
      this.stats.set((s) => ({ gaps: s.gaps + 1 }));
    }
    this.lastSeq = block.seq;

    const scale = 1 / 2 ** (block.bitDepth - 1);
    const pcm = new Float32Array(block.samples.length);
    for (let i = 0; i < pcm.length; i++) pcm[i] = block.samples[i]! * scale;
    this.node?.port.postMessage({ type: 'pcm', pcm }, [pcm.buffer]);

    this.windowBytes += payload.length;
    const now = performance.now();
    if (now - this.windowStart >= 1000) {
      this.stats.set({
        kbps: Math.round((this.windowBytes * 8) / ((now - this.windowStart) / 1000) / 1000),
      });
      this.windowBytes = 0;
      this.windowStart = now;
    }
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
      processorOptions: {
        channels: first.channels,
        targetMs: this.targetMs,
        windowMs: 40,
        maxMs: 1500,
      },
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = first.channels;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    node.connect(dest);
    node.port.onmessage = (e: MessageEvent<Partial<LosslessReceiverStats>>) =>
      this.stats.set(e.data);
    this.ctx = ctx;
    this.node = node;
    this.dest = dest;
    this.format = {
      sampleRate: first.sampleRate,
      channels: first.channels,
      bitDepth: first.bitDepth,
    };
    this.lastSeq = null;
    void ctx.resume();
    this.stats.set({ active: true, ...this.format });
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
    this.events.emit('stream', null);
    this.stats.set({ active: false, kbps: 0, bufferMs: 0 });
  }

  private teardown(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.dest?.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.dest = null;
    this.format = null;
  }

  dispose(): void {
    this.disposed = true;
    this.pending = [];
    this.teardown();
    this.events.clear();
  }
}
