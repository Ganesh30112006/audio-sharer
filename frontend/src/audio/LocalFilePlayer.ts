import { Disposer } from '../utils/disposer';
import { Emitter } from '../utils/emitter';
import { createStore, type Store } from '../utils/store';
import { createPlaybackContext, setContextSink } from './audioContext';
import { applySink } from './outputDevices';

const IDLE_SUSPEND_MS = 1500;

export type FilePlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface FilePlayerState {
  status: FilePlayerStatus;
  currentId: string | null;
  title: string | null;
  duration: number | null;
  rate: number;
  volume: number;
  monitor: boolean;
  buffering: boolean;
  error: string | null;
}

interface Tap {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  dest: MediaStreamAudioDestinationNode;
  monitorGain: GainNode;
}

/**
 * Plays local files through an HTMLAudioElement. When broadcasting, a Web
 * Audio tap exposes the decoded audio without re-decoding:
 *   element -> source -> destination stream (Opus/WebRTC)
 *                     \-> lossless capture worklet (attached by the sender)
 *                     \-> monitor gain -> speakers
 * The host's volume only changes the monitor, never the broadcast level.
 *
 * The tap's AudioContext can run at the file's native sample rate (lossless
 * mode). An element can only ever feed one context, so changing that rate
 * swaps in a fresh element, preserving position and play state.
 */
export class LocalFilePlayer {
  private _el: HTMLAudioElement;
  readonly store: Store<FilePlayerState>;
  /** Discrete state changes the sync layer should consider broadcasting; tapchange = tap rebuilt. */
  readonly events = new Emitter<{ change: void; ended: void; tapchange: void }>();
  private tap: Tap | null = null;
  private disposer = new Disposer();
  private sinkId = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this._el = LocalFilePlayer.createElement();
    this.store = createStore<FilePlayerState>({
      status: 'idle',
      currentId: null,
      title: null,
      duration: null,
      rate: 1,
      volume: 1,
      monitor: true,
      buffering: false,
      error: null,
    });
    this.bindElement();
  }

  get el(): HTMLAudioElement {
    return this._el;
  }

  private static createElement(): HTMLAudioElement {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    return el;
  }

  private bindElement(): void {
    this.disposer.dispose();
    this.disposer = new Disposer();
    const el = this._el;
    const set = this.store.set;
    const changed = () => this.events.emit('change', undefined);
    const on = (type: string, fn: () => void) => this.disposer.listen(el, type, fn);

    on('loadedmetadata', () => {
      set({ duration: Number.isFinite(el.duration) ? el.duration : null });
      changed();
    });
    on('durationchange', () =>
      set({ duration: Number.isFinite(el.duration) ? el.duration : null }),
    );
    on('playing', () => {
      set({ status: 'playing', buffering: false });
      this.cancelIdleSuspend();
      void this.tap?.ctx.resume();
      changed();
    });
    on('pause', () => {
      if (!el.ended) set({ status: 'paused' });
      this.scheduleIdleSuspend();
      changed();
    });
    on('waiting', () => set({ buffering: true }));
    on('seeked', changed);
    on('ratechange', () => {
      set({ rate: el.playbackRate });
      changed();
    });
    on('ended', () => {
      set({ status: 'ended' });
      this.scheduleIdleSuspend();
      changed();
      this.events.emit('ended', undefined);
    });
    on('error', () => {
      if (!el.getAttribute('src')) return;
      set({ status: 'error', error: 'This file could not be decoded.', buffering: false });
      changed();
    });
  }

  load(id: string, url: string, title: string): void {
    this.el.src = url;
    this.el.load();
    this.store.set({ status: 'loading', currentId: id, title, duration: null, error: null });
    this.events.emit('change', undefined);
  }

  /**
   * While nothing plays, the Web Audio graph would keep rendering and the
   * encoder keep sending silence. Suspending the context stops both; the
   * short delay avoids thrashing on track changes.
   */
  private scheduleIdleSuspend(): void {
    if (!this.tap || this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.tap && this.el.paused) void this.tap.ctx.suspend().catch(() => undefined);
    }, IDLE_SUSPEND_MS);
  }

  private cancelIdleSuspend(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async play(): Promise<void> {
    if (!this.el.getAttribute('src')) return;
    this.cancelIdleSuspend();
    await this.tap?.ctx.resume();
    try {
      await this.el.play();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.store.set({ status: 'paused', error: 'Playback was blocked. Press play again.' });
    }
  }

  pause(): void {
    this.el.pause();
  }

  seek(seconds: number): void {
    const d = this.el.duration;
    this.el.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(seconds, d) : seconds);
  }

  currentTime(): number {
    return this.el.currentTime;
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (this.tap)
      this.tap.monitorGain.gain.setTargetAtTime(this.store.get().monitor ? v : 0, 0, 0.02);
    else this.el.volume = v;
    this.store.set({ volume: v });
  }

  /** Mute/unmute local monitoring without affecting the broadcast. */
  setMonitor(on: boolean): void {
    this.store.set({ monitor: on });
    if (this.tap) this.tap.monitorGain.gain.value = on ? this.store.get().volume : 0;
    else this.el.muted = !on;
  }

  async setMonitorSink(deviceId: string): Promise<void> {
    this.sinkId = deviceId;
    if (this.tap) {
      const ok = await setContextSink(this.tap.ctx, deviceId);
      if (!ok && deviceId)
        throw new Error('This browser cannot route the monitor while broadcasting');
    } else {
      await applySink(this.el, deviceId);
    }
  }

  /**
   * Returns a track carrying the element's audio. Created once per player:
   * an element can only ever be attached to one MediaElementSource.
   */
  getBroadcastTrack(): MediaStreamTrack {
    const tap = this.ensureTap();
    const [track] = tap.dest.stream.getAudioTracks();
    if (!track) throw new Error('Audio tap produced no track');
    track.contentHint = 'music';
    return track;
  }

  /**
   * The tap's context and source node, at `sampleRate` if given (rebuilding
   * the element when the current tap runs at a different rate).
   */
  getTapSource(sampleRate?: number): { ctx: AudioContext; source: AudioNode } {
    const tap = this.ensureTap(sampleRate);
    return { ctx: tap.ctx, source: tap.source };
  }

  private ensureTap(sampleRate?: number): Tap {
    if (this.tap && sampleRate !== undefined && this.tap.ctx.sampleRate !== sampleRate) {
      this.replaceElement();
    }
    if (this.tap) return this.tap;
    // 'interactive' renders in small blocks: measured ~20 ms lower end-to-end
    // latency than 'playback' (median ~45 ms vs ~68 ms on a clean network).
    const ctx = createPlaybackContext('interactive', sampleRate ?? 48_000);
    const source = ctx.createMediaElementSource(this._el);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    const monitorGain = ctx.createGain();
    const { volume, monitor } = this.store.get();
    monitorGain.gain.value = monitor ? volume : 0;
    this._el.volume = 1;
    this._el.muted = false;
    source.connect(dest);
    source.connect(monitorGain).connect(ctx.destination);
    this.tap = { ctx, source, dest, monitorGain };
    if (this.sinkId) void setContextSink(ctx, this.sinkId).catch(() => undefined);
    if (!this._el.paused) void ctx.resume();
    else this.scheduleIdleSuspend();
    return this.tap;
  }

  /** Swap in a fresh element (and drop the tap), keeping source, position and play state. */
  private replaceElement(): void {
    const old = this._el;
    const src = old.getAttribute('src');
    const position = old.currentTime;
    const wasPlaying = !old.paused && !old.ended;
    this.disposer.dispose();
    this.teardownTap();
    old.pause();
    old.removeAttribute('src');
    old.load();
    this._el = LocalFilePlayer.createElement();
    this.bindElement();
    if (src) {
      this._el.src = src;
      this._el.currentTime = position;
      if (wasPlaying) void this.play();
    }
    this.events.emit('tapchange', undefined);
  }

  private teardownTap(): void {
    if (!this.tap) return;
    this.cancelIdleSuspend();
    this.tap.dest.stream.getTracks().forEach((t) => t.stop());
    this.tap.source.disconnect();
    this.tap.monitorGain.disconnect();
    void this.tap.ctx.close().catch(() => undefined);
    this.tap = null;
  }

  get isTapped(): boolean {
    return this.tap !== null;
  }

  /** Approximate output latency of the monitor path, seconds (if known). */
  outputLatency(): number | undefined {
    const ctx = this.tap?.ctx;
    if (!ctx) return undefined;
    return (ctx.outputLatency || 0) + ctx.baseLatency;
  }

  unload(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.store.set({
      status: 'idle',
      currentId: null,
      title: null,
      duration: null,
      buffering: false,
    });
    this.events.emit('change', undefined);
  }

  dispose(): void {
    this.cancelIdleSuspend();
    this.disposer.dispose();
    this.events.clear();
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.teardownTap();
  }
}
