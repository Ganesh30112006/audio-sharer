import { Disposer } from '../utils/disposer';
import { Emitter } from '../utils/emitter';
import { createStore, type Store } from '../utils/store';
import { createPlaybackContext, setContextSink } from './audioContext';
import { applySink } from './outputDevices';

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
 * Plays local files through a single HTMLAudioElement. When broadcasting, a
 * Web Audio tap turns the element output into a MediaStreamTrack without
 * re-decoding: element -> source -> destination stream (to WebRTC)
 *                                 \-> monitor gain -> speakers.
 * The host's volume only changes the monitor, never the broadcast level.
 */
export class LocalFilePlayer {
  readonly el: HTMLAudioElement;
  readonly store: Store<FilePlayerState>;
  /** Discrete state changes the sync layer should consider broadcasting. */
  readonly events = new Emitter<{ change: void; ended: void }>();
  private tap: Tap | null = null;
  private disposer = new Disposer();
  private sinkId = '';

  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
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

  private bindElement(): void {
    const el = this.el;
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
      void this.tap?.ctx.resume();
      changed();
    });
    on('pause', () => {
      if (!el.ended) set({ status: 'paused' });
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

  async play(): Promise<void> {
    if (!this.el.getAttribute('src')) return;
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
    if (!this.tap) {
      const ctx = createPlaybackContext();
      const source = ctx.createMediaElementSource(this.el);
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2;
      const monitorGain = ctx.createGain();
      const { volume, monitor } = this.store.get();
      monitorGain.gain.value = monitor ? volume : 0;
      this.el.volume = 1;
      this.el.muted = false;
      source.connect(dest);
      source.connect(monitorGain).connect(ctx.destination);
      this.tap = { ctx, source, dest, monitorGain };
      if (this.sinkId) void setContextSink(ctx, this.sinkId).catch(() => undefined);
      if (!this.el.paused) void ctx.resume();
    }
    const [track] = this.tap.dest.stream.getAudioTracks();
    if (!track) throw new Error('Audio tap produced no track');
    track.contentHint = 'music';
    return track;
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
    this.disposer.dispose();
    this.events.clear();
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    if (this.tap) {
      this.tap.dest.stream.getTracks().forEach((t) => t.stop());
      this.tap.source.disconnect();
      this.tap.monitorGain.disconnect();
      void this.tap.ctx.close().catch(() => undefined);
      this.tap = null;
    }
  }
}
