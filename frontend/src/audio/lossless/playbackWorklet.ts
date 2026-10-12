/**
 * Jitter buffer + output for the lossless stream, on the audio thread.
 *
 * - Starts (and restarts after an underrun) once `target` is buffered.
 * - Adaptive target (`adaptive: true`), a hybrid of three models:
 *   1. short-term: every block's arrival time is compared with where it
 *      belongs on the stream's own timeline; the spread of those offsets over
 *      the last ~10 s is the current network + decode + scheduling jitter;
 *   2. long-term: a decaying memory (30 s half-life) of the largest spreads,
 *      so a stall that happened recently is still covered;
 *   3. reactive: every underrun raises the target by a step.
 *   The target is the smallest buffer that covers the larger of (1) and (2)
 *   plus one block and one render quantum. It rises at once and falls only
 *   after several seconds of calm, so it settles at the lowest level this
 *   connection can sustain instead of a fixed worst-case delay.
 * - The sender's and this device's sample clocks differ by a few ppm. Drift is
 *   judged on a smoothed buffer level (~2 s average) so that the sawtooth of
 *   block-sized arrivals and network jitter never trigger corrections. When
 *   the average leaves ±window of the target, single frames are dropped or
 *   repeated (at most one per CORRECTION_SPACING quanta, faster while catching
 *   up with a changed target) until it is back within half the window.
 *   Counted in `clockCorrections`.
 * - If more than `maxMs` accumulates (e.g. after a network stall) the buffer
 *   is trimmed back to the target and counted in `resyncs`.
 */
interface PlaybackOptions {
  channels: number;
  targetMs: number;
  maxMs: number;
  /** Adapt the target to measured jitter (otherwise `targetMs` is fixed). */
  adaptive?: boolean;
  /** Lower bound for the adaptive target. */
  minMs?: number;
}

const SMOOTHING_SECONDS = 2;
/** Minimum render quanta between single-frame corrections (~21 ms at 48 kHz). */
const CORRECTION_SPACING = 8;
/** Spacing while the level is far from a changed target (~0.4% speed change). */
const CATCH_UP_SPACING = 2;
/** Arrival offsets kept for the jitter estimate (~10 s of 10 ms blocks). */
const JITTER_WINDOW = 1024;
const ADAPT_INTERVAL_S = 1;
/** Calm time required before the target may step down, and the step size. */
const LOWER_AFTER_S = 5;
const LOWER_STEP_MS = 5;
/** Target increase after an underrun. */
const UNDERRUN_STEP_MS = 10;
const SAFETY_MARGIN_MS = 5;
/**
 * Half-life of the long-term stall memory. A device that stalled once (GC,
 * scheduler hiccup, Wi-Fi scan) tends to stall again; remembering the spike
 * for a while avoids a second outage, and the decay lets the buffer come back
 * down once the connection has been calm for a few minutes.
 */
const STALL_HALF_LIFE_S = 30;

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  private readonly channels: number;
  private readonly cap: number;
  private readonly ring: Float32Array[];
  private readFrame = 0;
  private writeFrame = 0;
  private playing = false;
  private target: number;
  private window: number;
  private readonly max: number;
  private adaptive: boolean;
  private readonly minTarget: number;
  private underruns = 0;
  private clockCorrections = 0;
  private resyncs = 0;
  private overflows = 0;
  /** Frames output from stream data / silence output after first start / frames skipped or repeated. */
  private playedFrames = 0;
  private silenceFrames = 0;
  private skippedFrames = 0;
  private repeatedFrames = 0;
  private started = false;
  /** True until playback starts for the first time after creation or a reset. */
  private fresh = true;
  private lastReport = 0;
  /** Smoothed buffer level (frames) and correction state. */
  private avgLevel = 0;
  private correcting: -1 | 0 | 1 = 0;
  private sinceCorrection = 0;
  /** Arrival-offset history (seconds) since the last discontinuity. */
  private readonly offsets = new Float64Array(JITTER_WINDOW);
  private readonly sorted = new Float64Array(JITTER_WINDOW);
  private offsetCount = 0;
  private offsetNext = 0;
  /** Stream frames pushed since the last discontinuity. */
  private timelineFrames = 0;
  private blockFrames = 0;
  private lastAdapt = 0;
  private calmSince = 0;
  private jitterMs = 0;
  /** Long-term model: decaying peak of past spreads (seconds); survives resets. */
  private stallMemory = 0;
  private stallUpdated = 0;
  private adaptations = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const o = options.processorOptions as PlaybackOptions;
    this.channels = o.channels;
    this.cap = Math.ceil(sampleRate * 4);
    this.ring = Array.from({ length: o.channels }, () => new Float32Array(this.cap));
    this.max = this.frames(o.maxMs);
    this.adaptive = o.adaptive ?? false;
    this.minTarget = this.frames(o.minMs ?? 20);
    this.target = 0;
    this.window = 0;
    this.setTarget(this.frames(o.targetMs));
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as {
        type: string;
        pcm?: Float32Array;
        targetMs?: number;
        adaptive?: boolean;
      };
      if (msg.type === 'pcm' && msg.pcm) this.push(msg.pcm);
      else if (msg.type === 'target' && msg.targetMs !== undefined) {
        this.adaptive = msg.adaptive ?? this.adaptive;
        this.setTarget(this.frames(msg.targetMs));
        this.calmSince = currentTime;
      } else if (msg.type === 'reset') {
        // Discontinuity: never splice across a gap; flush and re-buffer.
        this.skippedFrames += this.writeFrame - this.readFrame;
        this.readFrame = this.writeFrame = 0;
        this.resetTimeline();
        this.fresh = true;
        if (this.playing) this.port.postMessage({ type: 'state', playing: false, reset: true });
        this.playing = false;
      }
    };
  }

  private frames(ms: number): number {
    return Math.round((ms / 1000) * sampleRate);
  }

  private setTarget(frames: number): void {
    this.target = Math.min(frames, Math.floor(this.max / 2));
    // Drift window scales with the target: wide enough that jitter in the
    // smoothed level never triggers corrections, narrow enough that the level
    // never sits far below a small target.
    this.window = Math.max(this.frames(5), Math.min(this.frames(40), Math.round(this.target / 4)));
  }

  private resetTimeline(): void {
    this.offsetCount = this.offsetNext = 0;
    this.timelineFrames = 0;
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
    // Arrival offset: how late this block is relative to the stream timeline.
    this.timelineFrames += frames;
    this.blockFrames = frames;
    const offset = currentTime - this.timelineFrames / sampleRate;
    this.offsets[this.offsetNext] = offset;
    this.offsetNext = (this.offsetNext + 1) % JITTER_WINDOW;
    if (this.offsetCount < JITTER_WINDOW) this.offsetCount++;
  }

  /** Smallest target that covers the measured jitter (frames). */
  private desiredTarget(quantum: number): number {
    const n = this.offsetCount;
    if (n < 16) return this.target;
    const s = this.sorted.subarray(0, n);
    s.set(this.offsets.subarray(0, n));
    s.sort();
    const shortTerm = s[n - 1]! - s[0]!;
    this.jitterMs = shortTerm * 1000;
    // Hybrid model: the short-term spread lets the target sit low while things
    // are calm; the long-term memory keeps room for stalls seen recently.
    const dt = currentTime - this.stallUpdated;
    this.stallUpdated = currentTime;
    this.stallMemory = Math.max(shortTerm, this.stallMemory * 0.5 ** (dt / STALL_HALF_LIFE_S));
    const spread = Math.max(shortTerm, this.stallMemory);
    // The level dips by one block between arrivals, may sit up to a window
    // below target, and must still hold one render quantum when a late block
    // is due: target - window - block/2 - jitter >= quantum + margin, with
    // window = target / 4.
    const need =
      this.blockFrames / 2 + spread * sampleRate + quantum + this.frames(SAFETY_MARGIN_MS);
    return Math.max(this.minTarget, Math.round((need * 4) / 3));
  }

  private adapt(quantum: number): void {
    if (!this.adaptive || currentTime - this.lastAdapt < ADAPT_INTERVAL_S) return;
    this.lastAdapt = currentTime;
    const want = this.desiredTarget(quantum);
    if (want > this.target) {
      this.setTarget(want);
      this.adaptations++;
      this.calmSince = currentTime;
    } else if (want < this.target - this.frames(LOWER_STEP_MS)) {
      if (currentTime - this.calmSince >= LOWER_AFTER_S) {
        this.setTarget(Math.max(want, this.target - this.frames(LOWER_STEP_MS)));
        this.adaptations++;
        this.calmSince = currentTime;
      }
    } else {
      this.calmSince = currentTime;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]!;
    const n = out[0]!.length;
    let level = this.writeFrame - this.readFrame;
    this.adapt(n);

    if (!this.playing && level >= this.target) {
      if (this.fresh) {
        // Blocks queued while the graph was built (or before a discontinuity
        // was resolved) arrive in one burst. Nothing has played yet, so start
        // at the target instead of carrying the backlog as permanent delay,
        // and measure jitter only from here on.
        if (level > this.target) {
          this.skippedFrames += level - this.target;
          this.readFrame = this.writeFrame - this.target;
          level = this.target;
        }
        this.resetTimeline();
        this.fresh = false;
      }
      this.playing = true;
      this.started = true;
      this.avgLevel = level;
      this.correcting = 0;
      this.port.postMessage({ type: 'state', playing: true });
    }
    if (this.playing && level < n) {
      this.playing = false;
      this.underruns++;
      if (this.adaptive) {
        // Re-buffer to a larger target; it only comes back down after calm.
        this.setTarget(this.target + this.frames(UNDERRUN_STEP_MS));
        this.adaptations++;
        this.calmSince = currentTime;
      }
      this.port.postMessage({ type: 'state', playing: false });
    }
    if (!this.playing) {
      for (const o of out) o.fill(0);
      if (this.started) this.silenceFrames += n;
      this.report(level);
      return true;
    }

    if (level > this.max) {
      this.skippedFrames += level - this.target;
      this.readFrame = this.writeFrame - this.target;
      this.resyncs++;
      level = this.target;
      this.avgLevel = level;
    }
    // Drift is judged on the smoothed level, not the instantaneous one.
    this.avgLevel += (level - this.avgLevel) * (n / (sampleRate * SMOOTHING_SECONDS));
    const dev = this.avgLevel - this.target;
    if (this.correcting === 0 && Math.abs(dev) > this.window) this.correcting = dev > 0 ? 1 : -1;
    else if (this.correcting !== 0 && Math.abs(dev) < this.window / 2) this.correcting = 0;
    const spacing = Math.abs(dev) > 2 * this.window ? CATCH_UP_SPACING : CORRECTION_SPACING;
    const due = this.correcting !== 0 && ++this.sinceCorrection >= spacing;
    if (due) this.sinceCorrection = 0;
    if (due && this.correcting === 1 && level > n + 1) {
      this.readFrame++; // drop one frame
      level--;
      this.avgLevel--;
      this.skippedFrames++;
      this.clockCorrections++;
    }
    const repeat = due && this.correcting === -1 && level > n;
    if (repeat) this.avgLevel++;
    for (let i = 0; i < n; i++) {
      const idx = (this.readFrame + i) % this.cap;
      for (let c = 0; c < out.length; c++)
        out[c]![i] = this.ring[Math.min(c, this.channels - 1)]![idx]!;
    }
    // Repeat one frame by advancing one less.
    this.readFrame += repeat ? n - 1 : n;
    this.playedFrames += repeat ? n - 1 : n;
    if (repeat) {
      this.clockCorrections++;
      this.repeatedFrames++;
    }
    this.report(this.writeFrame - this.readFrame);
    return true;
  }

  private report(level: number): void {
    if (currentTime - this.lastReport < 0.5) return;
    this.lastReport = currentTime;
    this.port.postMessage({
      type: 'stats',
      bufferMs: (level / sampleRate) * 1000,
      targetMs: (this.target / sampleRate) * 1000,
      jitterMs: this.jitterMs,
      stallMemoryMs: this.stallMemory * 1000,
      adaptations: this.adaptations,
      bufferedFrames: level,
      underruns: this.underruns,
      clockCorrections: this.clockCorrections,
      resyncs: this.resyncs,
      overflows: this.overflows,
      playedFrames: this.playedFrames,
      silenceFrames: this.silenceFrames,
      skippedFrames: this.skippedFrames,
      repeatedFrames: this.repeatedFrames,
      playing: this.playing,
    });
  }
}

registerProcessor('mc-pcm-playback', PcmPlaybackProcessor);
