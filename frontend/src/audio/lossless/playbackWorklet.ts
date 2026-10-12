/**
 * Jitter buffer + output for the lossless stream, on the audio thread.
 *
 * - Starts (and restarts after an underrun) once `targetMs` is buffered.
 * - The sender's and this device's sample clocks differ by a few ppm. When the
 *   buffer drifts outside ±`windowMs` of the target, a single frame is
 *   dropped or repeated per render quantum until it is back inside — a few
 *   frames per minute at typical clock offsets, counted in `clockCorrections`.
 * - If more than `maxMs` accumulates (e.g. after a network stall) the buffer
 *   is trimmed back to the target and counted in `resyncs`.
 */
interface PlaybackOptions {
  channels: number;
  targetMs: number;
  windowMs: number;
  maxMs: number;
}

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  private readonly channels: number;
  private readonly cap: number;
  private readonly ring: Float32Array[];
  private readFrame = 0;
  private writeFrame = 0;
  private playing = false;
  private target: number;
  private window: number;
  private max: number;
  private underruns = 0;
  private clockCorrections = 0;
  private resyncs = 0;
  private overflows = 0;
  private lastReport = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const o = options.processorOptions as PlaybackOptions;
    this.channels = o.channels;
    this.cap = Math.ceil(sampleRate * 4);
    this.ring = Array.from({ length: o.channels }, () => new Float32Array(this.cap));
    this.target = Math.round((o.targetMs / 1000) * sampleRate);
    this.window = Math.round((o.windowMs / 1000) * sampleRate);
    this.max = Math.round((o.maxMs / 1000) * sampleRate);
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; pcm?: Float32Array; targetMs?: number };
      if (msg.type === 'pcm' && msg.pcm) this.push(msg.pcm);
      else if (msg.type === 'target' && msg.targetMs !== undefined) {
        this.target = Math.round((msg.targetMs / 1000) * sampleRate);
      } else if (msg.type === 'reset') {
        this.readFrame = this.writeFrame = 0;
        this.playing = false;
      }
    };
  }

  private push(pcm: Float32Array): void {
    const ch = this.channels;
    const frames = Math.floor(pcm.length / ch);
    if (this.writeFrame + frames - this.readFrame > this.cap) {
      this.readFrame = this.writeFrame + frames - this.cap;
      this.overflows++;
    }
    for (let i = 0; i < frames; i++) {
      const idx = (this.writeFrame + i) % this.cap;
      for (let c = 0; c < ch; c++) this.ring[c]![idx] = pcm[i * ch + c]!;
    }
    this.writeFrame += frames;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]!;
    const n = out[0]!.length;
    let level = this.writeFrame - this.readFrame;

    if (!this.playing && level >= this.target) this.playing = true;
    if (this.playing && level < n) {
      this.playing = false;
      this.underruns++;
    }
    if (!this.playing) {
      for (const o of out) o.fill(0);
      this.report(level);
      return true;
    }

    if (level > this.max) {
      this.readFrame = this.writeFrame - this.target;
      this.resyncs++;
      level = this.target;
    } else if (level > this.target + this.window) {
      this.readFrame++; // drop one frame
      this.clockCorrections++;
    }
    const repeat = level < this.target - this.window && level > n;
    for (let i = 0; i < n; i++) {
      const idx = (this.readFrame + i) % this.cap;
      for (let c = 0; c < out.length; c++)
        out[c]![i] = this.ring[Math.min(c, this.channels - 1)]![idx]!;
    }
    // Repeat one frame by advancing one less.
    this.readFrame += repeat ? n - 1 : n;
    if (repeat) this.clockCorrections++;
    this.report(this.writeFrame - this.readFrame);
    return true;
  }

  private report(level: number): void {
    if (currentTime - this.lastReport < 0.5) return;
    this.lastReport = currentTime;
    this.port.postMessage({
      bufferMs: (level / sampleRate) * 1000,
      underruns: this.underruns,
      clockCorrections: this.clockCorrections,
      resyncs: this.resyncs,
      overflows: this.overflows,
      playing: this.playing,
    });
  }
}

registerProcessor('mc-pcm-playback', PcmPlaybackProcessor);
