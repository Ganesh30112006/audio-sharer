import { Disposer } from '../utils/disposer';
import { Emitter } from '../utils/emitter';
import { createStore, type Store } from '../utils/store';
import { createPlaybackContext } from './audioContext';
import { getCapabilities } from './capabilities';
import { correctDrift, DEFAULT_DRIFT_POLICY } from './driftCorrector';
import { applySink, type OutputDevice } from './outputDevices';

export const MAX_OUTPUTS = 4;
const MAX_DELAY_MS = 1000;
const DRIFT_TICK_MS = 250;

export type PlayerSource = { kind: 'stream'; stream: MediaStream } | { kind: 'url'; url: string };

export interface OutputSlotState {
  slotId: string;
  deviceId: string;
  label: string;
  /** Extra delay applied to this output to align it acoustically with slower outputs. */
  delayMs: number;
  volume: number;
  status: 'ok' | 'error' | 'missing';
  error: string | null;
}

export interface MultiOutputState {
  slots: OutputSlotState[];
  playing: boolean;
  /** Autoplay was blocked; a user gesture must call resume(). */
  needsGesture: boolean;
  /** Web Audio is in use (only when a stream output has a delay). */
  graphActive: boolean;
  /** Leader media duration in seconds (url sources), null if unknown/live. */
  duration: number | null;
}

interface Slot {
  state: OutputSlotState;
  el: HTMLAudioElement;
  chain: { delay: DelayNode; dest: MediaStreamAudioDestinationNode } | null;
}

/**
 * Plays one source on up to MAX_OUTPUTS devices, one HTMLAudioElement per
 * output (setSinkId). Bounded by design: every extra output costs one more
 * decode/mix path (url sources) or one more output stream (stream sources).
 *
 * - stream sources (remote WebRTC audio) share the MediaStream; per-output
 *   delay is applied via a Web Audio DelayNode only when requested.
 * - url sources (local files) run one element per output; followers are kept
 *   aligned to the leader by gradual playbackRate correction.
 */
export class MultiOutputPlayer {
  readonly store: Store<MultiOutputState>;
  readonly events = new Emitter<{ ended: void }>();
  private slots: Slot[] = [];
  private source: PlayerSource | null = null;
  private ctx: AudioContext | null = null;
  private ctxSource: MediaStreamAudioSourceNode | null = null;
  private primer: HTMLAudioElement | null = null;
  private driftTimer: ReturnType<typeof setTimeout> | null = null;
  private drift = new Map<string, number>();
  private disposer = new Disposer();
  private wantPlaying = false;

  constructor(private readonly maxOutputs = MAX_OUTPUTS) {
    this.store = createStore<MultiOutputState>({
      slots: [],
      playing: false,
      needsGesture: false,
      graphActive: false,
      duration: null,
    });
  }

  get canRoute(): boolean {
    return getCapabilities().setSinkId;
  }

  /** Last measured drift (ms) of an output relative to the leader, url sources only. */
  driftMs(slotId: string): number | undefined {
    return this.drift.get(slotId);
  }

  async addOutput(device: OutputDevice): Promise<void> {
    if (this.slots.some((s) => s.state.deviceId === device.deviceId)) {
      throw new Error(`${device.label} is already in use`);
    }
    if (this.slots.length >= this.maxOutputs) {
      throw new Error(`At most ${this.maxOutputs} outputs can play at once`);
    }
    if (device.deviceId && !this.canRoute) {
      throw new Error('This browser can only play through the system default output');
    }
    const el = new Audio();
    el.preload = 'auto';
    el.autoplay = false;
    const slot: Slot = {
      el,
      chain: null,
      state: {
        slotId: crypto.randomUUID().slice(0, 8),
        deviceId: device.deviceId,
        label: device.label,
        delayMs: 0,
        volume: 1,
        status: 'ok',
        error: null,
      },
    };
    try {
      await applySink(el, device.deviceId);
    } catch (err) {
      el.remove();
      throw new Error(`Could not route to ${device.label}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    this.slots.push(slot);
    if (this.slots.length === 1) this.bindLeader(el);
    this.wireSlot(slot);
    this.publishSlots();
    if (this.wantPlaying) await this.playSlot(slot);
    this.updateDriftLoop();
  }

  removeOutput(slotId: string): void {
    const idx = this.slots.findIndex((s) => s.state.slotId === slotId);
    if (idx < 0) return;
    const [slot] = this.slots.splice(idx, 1);
    if (!slot) return;
    this.teardownSlot(slot);
    this.drift.delete(slotId);
    if (idx === 0) {
      this.leaderDisposer?.dispose();
      const next = this.slots[0];
      if (next) this.bindLeader(next.el);
    }
    this.publishSlots();
    this.syncGraphLifecycle();
    this.updateDriftLoop();
  }

  setSource(source: PlayerSource | null): void {
    this.source = source;
    this.ctxSource?.disconnect();
    this.ctxSource = null;
    for (const slot of this.slots) this.wireSlot(slot);
    this.syncGraphLifecycle();
    if (this.wantPlaying && source) void this.play();
    this.updateDriftLoop();
  }

  setDelay(slotId: string, delayMs: number): void {
    const slot = this.find(slotId);
    if (!slot) return;
    const ms = Math.round(Math.min(MAX_DELAY_MS, Math.max(0, delayMs)));
    const hadChain = !!slot.chain;
    slot.state = { ...slot.state, delayMs: ms };
    if (this.source?.kind === 'stream') {
      if (ms > 0 && slot.chain) slot.chain.delay.delayTime.setTargetAtTime(ms / 1000, 0, 0.05);
      else if (ms > 0 !== hadChain) this.wireSlot(slot);
    }
    this.publishSlots();
    this.syncGraphLifecycle();
  }

  setVolume(slotId: string, volume: number): void {
    const slot = this.find(slotId);
    if (!slot) return;
    slot.el.volume = Math.min(1, Math.max(0, volume));
    slot.state = { ...slot.state, volume: slot.el.volume };
    this.publishSlots();
  }

  /** Mark outputs whose device disappeared (e.g. Bluetooth disconnected). */
  reconcileDevices(available: OutputDevice[]): void {
    const ids = new Set(available.map((d) => d.deviceId));
    let changed = false;
    for (const slot of this.slots) {
      const missing = slot.state.deviceId !== '' && !ids.has(slot.state.deviceId);
      const status = missing
        ? 'missing'
        : slot.state.status === 'missing'
          ? 'ok'
          : slot.state.status;
      if (status !== slot.state.status) {
        slot.state = { ...slot.state, status, error: missing ? 'Device disconnected' : null };
        changed = true;
      }
    }
    if (changed) this.publishSlots();
  }

  async play(): Promise<void> {
    this.wantPlaying = true;
    if (!this.source || this.slots.length === 0) return;
    await this.ctx?.resume().catch(() => undefined);
    if (this.primer) void this.primer.play().catch(() => undefined);
    await Promise.all(this.slots.map((s) => this.playSlot(s)));
    this.store.set({ playing: this.slots.some((s) => !s.el.paused) });
    this.updateDriftLoop();
  }

  /** Retry after autoplay was blocked; call from a user gesture. */
  resume(): Promise<void> {
    this.store.set({ needsGesture: false });
    return this.play();
  }

  pause(): void {
    this.wantPlaying = false;
    for (const s of this.slots) s.el.pause();
    this.primer?.pause();
    this.store.set({ playing: false });
    this.updateDriftLoop();
  }

  seek(seconds: number): void {
    if (this.source?.kind !== 'url') return;
    const leaderDelay = this.slots[0]?.state.delayMs ?? 0;
    for (const s of this.slots) {
      s.el.currentTime = Math.max(0, seconds - (s.state.delayMs - leaderDelay) / 1000);
    }
  }

  currentTime(): number {
    return this.slots[0]?.el.currentTime ?? 0;
  }

  dispose(): void {
    this.wantPlaying = false;
    this.stopDriftLoop();
    this.leaderDisposer?.dispose();
    this.disposer.dispose();
    for (const slot of this.slots) this.teardownSlot(slot);
    this.slots = [];
    this.teardownGraph();
    this.events.clear();
    this.source = null;
  }

  // ---- internals -------------------------------------------------------

  private leaderDisposer: Disposer | null = null;

  private bindLeader(el: HTMLAudioElement): void {
    this.leaderDisposer?.dispose();
    const d = (this.leaderDisposer = new Disposer());
    d.listen(el, 'ended', () => {
      this.wantPlaying = false;
      this.store.set({ playing: false });
      this.updateDriftLoop();
      this.events.emit('ended', undefined);
    });
    d.listen(el, 'playing', () => this.store.set({ playing: true }));
    const updateDuration = () =>
      this.store.set({ duration: Number.isFinite(el.duration) ? el.duration : null });
    d.listen(el, 'durationchange', updateDuration);
    d.listen(el, 'emptied', updateDuration);
    updateDuration();
  }

  private find(slotId: string): Slot | undefined {
    return this.slots.find((s) => s.state.slotId === slotId);
  }

  private publishSlots(): void {
    this.store.set({ slots: this.slots.map((s) => s.state) });
  }

  private wireSlot(slot: Slot): void {
    this.unwireChain(slot);
    const { el } = slot;
    const src = this.source;
    if (!src) {
      el.srcObject = null;
      el.removeAttribute('src');
      return;
    }
    if (src.kind === 'url') {
      el.srcObject = null;
      if (el.getAttribute('src') !== src.url) {
        el.src = src.url;
        const leader = this.slots[0]?.el;
        if (leader && leader !== el && leader.currentTime > 0) el.currentTime = leader.currentTime;
      }
      return;
    }
    el.removeAttribute('src');
    if (slot.state.delayMs > 0) {
      const ctx = this.ensureGraph(src.stream);
      const delay = ctx.createDelay(MAX_DELAY_MS / 1000);
      delay.delayTime.value = slot.state.delayMs / 1000;
      const dest = ctx.createMediaStreamDestination();
      this.ctxSource!.connect(delay).connect(dest);
      slot.chain = { delay, dest };
      el.srcObject = dest.stream;
    } else {
      el.srcObject = src.stream;
    }
    if (this.wantPlaying) void this.playSlot(slot);
  }

  private unwireChain(slot: Slot): void {
    if (!slot.chain) return;
    slot.chain.delay.disconnect();
    slot.chain.dest.stream.getTracks().forEach((t) => t.stop());
    slot.chain = null;
  }

  private teardownSlot(slot: Slot): void {
    this.unwireChain(slot);
    slot.el.pause();
    slot.el.srcObject = null;
    slot.el.removeAttribute('src');
    slot.el.load();
  }

  private ensureGraph(stream: MediaStream): AudioContext {
    this.ctx ??= createPlaybackContext();
    if (!this.ctxSource) {
      this.ctxSource = this.ctx.createMediaStreamSource(stream);
      // Chromium only pulls remote WebRTC audio into Web Audio while the
      // stream is also attached to a media element; a muted one suffices.
      this.primer = new Audio();
      this.primer.muted = true;
      this.primer.srcObject = stream;
      if (this.wantPlaying) void this.primer.play().catch(() => undefined);
    }
    this.store.set({ graphActive: true });
    return this.ctx;
  }

  /** Close Web Audio as soon as no output needs it. */
  private syncGraphLifecycle(): void {
    if (this.slots.some((s) => s.chain)) return;
    this.teardownGraph();
  }

  private teardownGraph(): void {
    this.ctxSource?.disconnect();
    this.ctxSource = null;
    if (this.primer) {
      this.primer.pause();
      this.primer.srcObject = null;
      this.primer = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.store.set({ graphActive: false });
  }

  private async playSlot(slot: Slot): Promise<void> {
    if (!slot.el.srcObject && !slot.el.getAttribute('src')) return;
    try {
      await slot.el.play();
      if (slot.state.status === 'error') {
        slot.state = { ...slot.state, status: 'ok', error: null };
        this.publishSlots();
      }
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        this.store.set({ needsGesture: true });
      } else if (name !== 'AbortError') {
        slot.state = { ...slot.state, status: 'error', error: (err as Error).message };
        this.publishSlots();
      }
    }
  }

  private updateDriftLoop(): void {
    const needed = this.wantPlaying && this.source?.kind === 'url' && this.slots.length > 1;
    if (needed && this.driftTimer === null) this.scheduleDrift();
    else if (!needed) this.stopDriftLoop();
  }

  private scheduleDrift(): void {
    this.driftTimer = setTimeout(() => {
      this.driftTimer = null;
      this.correctFollowers();
      this.updateDriftLoop();
    }, DRIFT_TICK_MS);
  }

  private stopDriftLoop(): void {
    if (this.driftTimer !== null) clearTimeout(this.driftTimer);
    this.driftTimer = null;
    for (const s of this.slots) if (s.el.playbackRate !== 1) s.el.playbackRate = 1;
  }

  /**
   * Coarse periodic measurement is sufficient here: corrections are gradual
   * rate nudges, not sample-accurate scheduling.
   */
  private correctFollowers(): void {
    const [leader, ...followers] = this.slots;
    if (!leader || leader.el.paused || leader.el.seeking) return;
    const base = leader.el.playbackRate || 1;
    const leaderTime = leader.el.currentTime;
    for (const f of followers) {
      const target = leaderTime - (f.state.delayMs - leader.state.delayMs) / 1000;
      if (target < 0) {
        // This output is delayed and its start point hasn't arrived yet.
        if (!f.el.paused) f.el.pause();
        f.el.currentTime = 0;
        continue;
      }
      if (f.el.paused) void this.playSlot(f);
      if (f.el.seeking || f.el.readyState < 3) continue;
      const drift = f.el.currentTime - target;
      this.drift.set(f.state.slotId, drift * 1000);
      const action = correctDrift(drift, target, base, DEFAULT_DRIFT_POLICY);
      if (action.kind === 'seek') f.el.currentTime = action.position;
      if (f.el.playbackRate !== action.rate) f.el.playbackRate = action.rate;
    }
  }
}
