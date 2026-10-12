/**
 * Runs on the audio rendering thread. Converts float samples to integers at
 * the source bit depth (exact for integer-PCM sources: float32 represents
 * every 16/24-bit value exactly) and hands fixed-size interleaved blocks to
 * the main thread. No encoding happens here to keep the audio thread light.
 */
interface CaptureOptions {
  blockFrames: number;
  bitDepth: number;
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly blockFrames: number;
  private readonly scale: number;
  private readonly lo: number;
  private readonly hi: number;
  private channels = 0;
  private buf: Int32Array | null = null;
  private filled = 0;
  private stopped = false;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const o = options.processorOptions as CaptureOptions;
    this.blockFrames = o.blockFrames;
    this.scale = 2 ** (o.bitDepth - 1);
    this.lo = -this.scale;
    this.hi = this.scale - 1;
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'stop') this.stopped = true;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (this.stopped) return false;
    if (!input || input.length === 0) return true;
    const ch = input.length;
    if (ch !== this.channels || !this.buf) {
      this.channels = ch;
      this.buf = new Int32Array(this.blockFrames * ch);
      this.filled = 0;
    }
    const frames = input[0]!.length;
    for (let i = 0; i < frames; i++) {
      const base = this.filled * ch;
      for (let c = 0; c < ch; c++) {
        let v = Math.round(input[c]![i]! * this.scale);
        if (v < this.lo) v = this.lo;
        else if (v > this.hi) v = this.hi;
        this.buf[base + c] = v;
      }
      if (++this.filled === this.blockFrames) {
        this.port.postMessage({ samples: this.buf, channels: ch }, [this.buf.buffer]);
        this.buf = new Int32Array(this.blockFrames * ch);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('mc-pcm-capture', PcmCaptureProcessor);
