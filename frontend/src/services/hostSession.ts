import { createPlaybackContext } from '../audio/audioContext';
import { LocalFilePlayer } from '../audio/LocalFilePlayer';
import { exposeTrace, latencyTraceEnabled, SenderTrace } from '../audio/lossless/latencyTrace';
import { LosslessSender } from '../audio/lossless/LosslessSender';
import { policyFor, type QualityPreset, type SourcePolicy } from '../audio/sourcePolicy';
import {
  captureDisplayAudio,
  captureMicrophone,
  CaptureError,
  type OwnedCapture,
} from '../media/capture';
import { DEFAULT_FORMAT, probeFormat, type SourceFormat } from '../media/audioFormat';
import { checkAudioFile, FileLibrary, type QueueItem } from '../media/fileSource';
import { PCM_TOPIC, type PlaybackStatus, type SourceKind, type Transport } from '../types/sync';
import { ServerClock } from '../utils/clock';
import { Disposer } from '../utils/disposer';
import { createStore, type Store } from '../utils/store';
import { api } from './api';
import { RoomConnection } from './roomConnection';
import { settingsStore } from './settings';
import { encodeState } from './syncProtocol';
import { SyncPublisher } from './syncService';

export type HostPhase = 'idle' | 'connecting' | 'ready' | 'ended' | 'error';

export interface HostState {
  phase: HostPhase;
  source: SourceKind;
  /** Host wants the source broadcast to listeners. */
  live: boolean;
  queue: QueueItem[];
  captureLabel: string | null;
  /** opus = lowest latency WebRTC track; lossless = bit-exact PCM over the data channel. */
  transport: Transport;
  quality: QualityPreset;
  lossProtection: boolean;
  /** Restart the queue from the top after the last item. */
  repeat: boolean;
  busy: boolean;
  error: string | null;
  notices: string[];
}

/**
 * Orchestrates one hosted room: control-plane token, SFU connection, the
 * active audio source and playback-state broadcasting. React components call
 * its methods and subscribe to its stores; no media objects live in React.
 */
export class HostSession {
  readonly conn = new RoomConnection('host');
  readonly player = new LocalFilePlayer();
  readonly library = new FileLibrary();
  readonly clock = new ServerClock(api.serverTime);
  readonly sync: SyncPublisher;
  readonly store: Store<HostState>;
  /** Per-block latency trace, only when `mc.latencyTrace` is set (benchmarks). */
  private readonly latencyTrace = latencyTraceEnabled()
    ? new SenderTrace(() => this.clock.current)
    : null;
  readonly lossless = new LosslessSender(
    (payload) => this.conn.sendData(payload, undefined, PCM_TOPIC),
    () => this.clock.now(),
    this.latencyTrace,
  );
  private capture: OwnedCapture | null = null;
  /** Web Audio graph feeding a capture track to the lossless sender. */
  private captureGraph: { ctx: AudioContext; source: MediaStreamAudioSourceNode } | null = null;
  private disposer = new Disposer();
  private disposed = false;

  constructor(
    readonly code: string,
    private readonly hostKey: string,
  ) {
    if (this.latencyTrace) exposeTrace('host', this.latencyTrace);
    this.store = createStore<HostState>({
      phase: 'idle',
      source: 'file',
      live: false,
      queue: [],
      captureLabel: null,
      transport: settingsStore.get().transport,
      quality: settingsStore.get().quality,
      lossProtection: settingsStore.get().lossProtection,
      repeat: false,
      busy: false,
      error: null,
      notices: [],
    });
    this.sync = new SyncPublisher(
      () => this.clock.now(),
      (state, to) => void this.conn.sendData(encodeState(state), to).catch(() => undefined),
    );
    this.disposer.add(this.player.events.on('change', () => this.pushSync()));
    this.disposer.add(this.player.events.on('ended', () => this.next(true)));
    this.disposer.add(
      this.conn.events.on('participantJoined', ({ identity }) => this.sync.sendSnapshot(identity)),
    );
  }

  async start(displayName: string): Promise<void> {
    if (this.store.get().phase !== 'idle') return;
    this.store.set({ phase: 'connecting', error: null });
    try {
      const [grant] = await Promise.all([
        api.token(this.code, 'host', displayName || 'Host', this.hostKey),
        this.clock.sync(),
      ]);
      if (this.disposed) return;
      await this.conn.connect(grant);
      if (this.disposed) return;
      this.store.set({ phase: 'ready' });
      this.pushSync();
    } catch (err) {
      if (this.disposed) return;
      this.store.set({ phase: 'error', error: (err as Error).message });
    }
  }

  // ---- files & queue ---------------------------------------------------

  async addFiles(files: Iterable<File>): Promise<void> {
    const added: QueueItem[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const check = checkAudioFile(file);
      if (check.ok && check.mime) {
        // Header-only read (64 KB) so lossless mode knows the native rate/bit depth.
        added.push(this.library.add(file, check.mime, await probeFormat(file)));
      } else if (check.reason) rejected.push(check.reason);
    }
    if (this.disposed) return;
    this.store.set((s) => ({ queue: [...s.queue, ...added], notices: rejected }));
    if (added[0] && !this.player.store.get().currentId) this.loadItem(added[0].id, false);
  }

  removeItem(id: string): void {
    const { queue } = this.store.get();
    if (this.player.store.get().currentId === id) {
      this.player.unload();
      this.library.release(id);
    }
    this.library.remove(id);
    this.store.set({ queue: queue.filter((q) => q.id !== id) });
  }

  loadItem(id: string, autoplay = true): void {
    const item = this.store.get().queue.find((q) => q.id === id);
    if (!item) return;
    const prev = this.player.store.get().currentId;
    const url = this.library.urlFor(id);
    if (!url) return;
    this.player.load(id, url, item.title);
    if (prev && prev !== id) this.library.release(prev);
    const { live, transport, source } = this.store.get();
    if (source !== 'file') void this.useFile();
    else if (live && transport === 'lossless') {
      // Re-targets the tap to this file's native rate before playback starts.
      void this.publishCurrent().catch((err: unknown) =>
        this.store.set({ error: (err as Error).message }),
      );
    }
    if (autoplay) void this.player.play();
  }

  next(auto = false): void {
    const { queue } = this.store.get();
    const idx = queue.findIndex((q) => q.id === this.player.store.get().currentId);
    const nextItem = queue[idx + 1] ?? (this.store.get().repeat ? queue[0] : undefined);
    if (nextItem) this.loadItem(nextItem.id, true);
    else if (auto) this.pushSync();
  }

  previous(): void {
    if (this.player.currentTime() > 3) {
      this.player.seek(0);
      return;
    }
    const { queue } = this.store.get();
    const idx = queue.findIndex((q) => q.id === this.player.store.get().currentId);
    const prevItem = queue[idx - 1];
    if (prevItem) this.loadItem(prevItem.id, true);
    else this.player.seek(0);
  }

  // ---- source selection --------------------------------------------------

  async useFile(): Promise<void> {
    this.releaseCapture();
    this.store.set({ source: 'file', captureLabel: null, error: null });
    if (this.store.get().live) await this.publishCurrent();
    this.pushSync();
  }

  async useCapture(kind: 'capture' | 'microphone'): Promise<void> {
    if (this.store.get().busy) return;
    this.store.set({ busy: true, error: null });
    const policy = this.policy(kind);
    try {
      const cap =
        kind === 'capture' ? await captureDisplayAudio(policy) : await captureMicrophone(policy);
      if (this.disposed) {
        cap.stop();
        return;
      }
      this.player.pause();
      this.releaseCapture();
      this.capture = cap;
      cap.onEnded(() => {
        if (this.capture === cap) void this.useFile();
      });
      this.store.set({ source: kind, captureLabel: cap.label || null });
      if (this.store.get().live) await this.publishCurrent();
      this.pushSync();
    } catch (err) {
      this.store.set({
        error: err instanceof CaptureError ? err.message : 'Could not start capture.',
      });
    } finally {
      this.store.set({ busy: false });
    }
  }

  private releaseCapture(): void {
    this.closeCaptureGraph();
    this.capture?.stop();
    this.capture = null;
  }

  private closeCaptureGraph(): void {
    if (!this.captureGraph) return;
    this.lossless.stop();
    this.captureGraph.source.disconnect();
    void this.captureGraph.ctx.close().catch(() => undefined);
    this.captureGraph = null;
  }

  private currentFormat(): SourceFormat {
    const id = this.player.store.get().currentId;
    return this.store.get().queue.find((q) => q.id === id)?.format ?? DEFAULT_FORMAT;
  }

  // ---- broadcasting ------------------------------------------------------

  async setLive(live: boolean): Promise<void> {
    if (this.store.get().busy) return;
    this.store.set({ busy: true, error: null });
    try {
      if (live) {
        this.store.set({ live: true });
        await this.publishCurrent();
      } else {
        this.store.set({ live: false });
        this.lossless.stop();
        await this.conn.unpublishAudio();
      }
      this.pushSync();
    } catch (err) {
      this.store.set({
        live: false,
        error: `Could not start broadcasting: ${(err as Error).message}`,
      });
    } finally {
      this.store.set({ busy: false });
    }
  }

  async setQuality(quality: QualityPreset): Promise<void> {
    this.store.set({ quality });
    if (this.store.get().live) await this.publishCurrent();
  }

  async setTransport(transport: Transport): Promise<void> {
    this.store.set({ transport });
    if (this.store.get().live) await this.publishCurrent();
    this.pushSync();
  }

  async setLossProtection(lossProtection: boolean): Promise<void> {
    this.store.set({ lossProtection });
    if (this.store.get().live) await this.publishCurrent();
  }

  /** Transport policy for a source under the host's current settings. */
  policy(kind: SourceKind = this.store.get().source): SourcePolicy {
    const { quality, lossProtection } = this.store.get();
    return policyFor(kind, quality, {
      voiceProcessing: settingsStore.get().voiceProcessing,
      lossProtection,
    });
  }

  private async publishCurrent(): Promise<void> {
    const { source, transport } = this.store.get();
    if (transport === 'lossless') {
      await this.conn.unpublishAudio();
      await this.startLossless(source);
      return;
    }
    this.lossless.stop();
    this.closeCaptureGraph();
    const policy = this.policy(source);
    let track: MediaStreamTrack | undefined;
    let name: string;
    if (source === 'file') {
      track = this.player.getBroadcastTrack();
      name = 'file';
    } else {
      track = this.capture?.track;
      name = source;
    }
    if (!track) throw new Error('No active audio source');
    await this.conn.publishAudio(track, policy, name);
  }

  private async startLossless(source: SourceKind): Promise<void> {
    if (source === 'file') {
      this.closeCaptureGraph();
      const format = this.currentFormat();
      const { ctx, source: node } = this.player.getTapSource(format.sampleRate);
      await this.lossless.start(ctx, node, format.bitDepth);
      return;
    }
    const track = this.capture?.track;
    if (!track) throw new Error('No active audio source');
    if (!this.captureGraph) {
      const rate = track.getSettings().sampleRate ?? 48_000;
      const ctx = createPlaybackContext('interactive', rate);
      const node = ctx.createMediaStreamSource(new MediaStream([track]));
      this.captureGraph = { ctx, source: node };
      void ctx.resume();
    }
    // Captured audio arrives as float from the OS mixer; 24-bit keeps its full precision.
    await this.lossless.start(this.captureGraph.ctx, this.captureGraph.source, 24);
  }

  // ---- sync --------------------------------------------------------------

  private pushSync(): void {
    if (this.store.get().phase !== 'ready') return;
    const { source, live, captureLabel, transport } = this.store.get();
    if (source === 'file') {
      const p = this.player.store.get();
      const status: PlaybackStatus =
        p.status === 'playing' ? 'playing' : p.status === 'idle' ? 'stopped' : 'paused';
      this.sync.update({
        status: live ? status : 'stopped',
        position: this.player.currentTime(),
        rate: p.rate,
        sourceId: p.currentId,
        sourceKind: 'file',
        title: p.title,
        duration: p.duration,
        transport,
      });
    } else {
      this.sync.update({
        status: live ? 'playing' : 'stopped',
        position: 0,
        rate: 1,
        sourceId: source,
        sourceKind: source,
        title: captureLabel ?? (source === 'capture' ? 'Shared audio' : 'Live microphone'),
        duration: null,
        transport,
      });
    }
  }

  setRepeat(repeat: boolean): void {
    this.store.set({ repeat });
  }

  dismissNotices(): void {
    this.store.set({ notices: [] });
  }

  /** Close the room for everyone. */
  async end(): Promise<void> {
    try {
      await api.closeRoom(this.code, this.hostKey);
    } catch {
      // The room may already have expired; local teardown still happens.
    }
    this.store.set({ phase: 'ended' });
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.latencyTrace?.dispose();
    if (this.disposed) return;
    this.disposed = true;
    this.disposer.dispose();
    this.lossless.dispose();
    this.releaseCapture();
    await this.conn.disconnect();
    this.player.dispose();
    this.library.clear();
  }
}
