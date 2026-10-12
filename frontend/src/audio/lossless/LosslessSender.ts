import captureWorkletUrl from './captureWorklet.ts?worker&url';
import { createStore, type Store } from '../../utils/store';
import { encodeBlock } from './codec';

/** Target block duration. */
const BLOCK_MS = 20;
/**
 * Cap on a block's raw size so one encoded block always fits a single reliable
 * data-channel message (LiveKit recommends < 15 KiB). Hi-res streams therefore
 * use shorter blocks: 24-bit/192 kHz stereo -> 2000 frames (~10 ms).
 */
const MAX_RAW_BLOCK_BYTES = 12_000;

export function blockFramesFor(sampleRate: number, bitDepth: number, channels = 2): number {
  const byDuration = Math.round((sampleRate * BLOCK_MS) / 1000);
  const bySize = Math.floor(MAX_RAW_BLOCK_BYTES / (channels * Math.ceil(bitDepth / 8)));
  return Math.max(64, Math.min(byDuration, bySize));
}
/** Unacknowledged sends beyond this mean the network can't sustain the rate. */
const CONGESTION_IN_FLIGHT = 25;

export interface LosslessSenderStats {
  active: boolean;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  /** Payload sent per second, kbit/s. */
  kbps: number;
  /** Encoded size / raw PCM size over the last second. */
  ratio: number;
  inFlight: number;
  congested: boolean;
  blocksSent: number;
}

type Send = (payload: Uint8Array<ArrayBuffer>) => Promise<void>;

/**
 * Captures integer PCM from an AudioNode (via an AudioWorklet), compresses it
 * losslessly and sends it over the SFU's reliable, ordered data channel.
 * One sender per host; the SFU fans packets out to every listener.
 */
export class LosslessSender {
  readonly stats: Store<LosslessSenderStats> = createStore<LosslessSenderStats>({
    active: false,
    sampleRate: 0,
    bitDepth: 0,
    channels: 0,
    kbps: 0,
    ratio: 1,
    inFlight: 0,
    congested: false,
    blocksSent: 0,
  });
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private source: AudioNode | null = null;
  private seq = 0;
  private inFlight = 0;
  private windowBytes = 0;
  private windowRaw = 0;
  private windowBlocks = 0;
  private windowStart = 0;
  private static modules = new WeakMap<BaseAudioContext, Promise<void>>();

  constructor(private readonly send: Send) {}

  async start(ctx: AudioContext, source: AudioNode, bitDepth: number): Promise<void> {
    // Same graph and format: keep streaming without a gap.
    if (
      this.node &&
      this.source === source &&
      this.node.context === ctx &&
      this.stats.get().bitDepth === bitDepth
    ) {
      return;
    }
    this.stop();
    let loaded = LosslessSender.modules.get(ctx);
    if (!loaded) {
      loaded = ctx.audioWorklet.addModule(captureWorkletUrl);
      LosslessSender.modules.set(ctx, loaded);
    }
    await loaded;
    const blockFrames = blockFramesFor(ctx.sampleRate, bitDepth);
    const node = new AudioWorkletNode(ctx, 'mc-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: 'max',
      channelInterpretation: 'discrete',
      processorOptions: { blockFrames, bitDepth },
    });
    // The node must reach the destination to be rendered; it outputs silence.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    source.connect(node);
    node.port.onmessage = (e: MessageEvent<{ samples: Int32Array; channels: number }>) =>
      this.onBlock(ctx.sampleRate, bitDepth, e.data);
    this.node = node;
    this.sink = sink;
    this.source = source;
    this.windowStart = performance.now();
    this.stats.set({ active: true, sampleRate: ctx.sampleRate, bitDepth, channels: 0 });
  }

  private onBlock(
    sampleRate: number,
    bitDepth: number,
    { samples, channels }: { samples: Int32Array; channels: number },
  ): void {
    const payload = encodeBlock({ seq: this.seq++, sampleRate, channels, bitDepth, samples });
    this.inFlight++;
    this.send(payload)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight--;
      });
    this.windowBytes += payload.length;
    this.windowBlocks++;
    this.windowRaw += (samples.length * bitDepth) / 8;
    const now = performance.now();
    if (now - this.windowStart >= 1000) {
      const secs = (now - this.windowStart) / 1000;
      this.stats.set((s) => ({
        channels,
        kbps: Math.round((this.windowBytes * 8) / secs / 1000),
        ratio: this.windowRaw ? +(this.windowBytes / this.windowRaw).toFixed(3) : 1,
        inFlight: this.inFlight,
        congested: this.inFlight > CONGESTION_IN_FLIGHT,
        blocksSent: s.blocksSent + this.windowBlocks,
      }));
      this.windowStart = now;
      this.windowBytes = 0;
      this.windowRaw = 0;
      this.windowBlocks = 0;
    }
  }

  stop(): void {
    if (!this.node) return;
    this.node.port.postMessage('stop');
    this.node.port.onmessage = null;
    try {
      this.source?.disconnect(this.node);
    } catch {
      // already disconnected
    }
    this.node.disconnect();
    this.sink?.disconnect();
    this.node = null;
    this.sink = null;
    this.source = null;
    this.stats.set({ active: false, kbps: 0, inFlight: 0, congested: false });
  }
}
