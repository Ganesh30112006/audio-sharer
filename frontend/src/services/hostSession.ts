import { LocalFilePlayer } from '../audio/LocalFilePlayer';
import { policyFor, type QualityPreset } from '../audio/sourcePolicy';
import {
  captureDisplayAudio,
  captureMicrophone,
  CaptureError,
  type OwnedCapture,
} from '../media/capture';
import { checkAudioFile, FileLibrary, type QueueItem } from '../media/fileSource';
import type { PlaybackStatus, SourceKind } from '../types/sync';
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
  quality: QualityPreset;
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
  private capture: OwnedCapture | null = null;
  private disposer = new Disposer();
  private disposed = false;

  constructor(
    readonly code: string,
    private readonly hostKey: string,
  ) {
    this.store = createStore<HostState>({
      phase: 'idle',
      source: 'file',
      live: false,
      queue: [],
      captureLabel: null,
      quality: settingsStore.get().quality,
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

  addFiles(files: Iterable<File>): void {
    const added: QueueItem[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const check = checkAudioFile(file);
      if (check.ok && check.mime) added.push(this.library.add(file, check.mime));
      else if (check.reason) rejected.push(check.reason);
    }
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
    if (this.store.get().source !== 'file') void this.useFile();
    if (autoplay) void this.player.play();
  }

  next(auto = false): void {
    const { queue } = this.store.get();
    const idx = queue.findIndex((q) => q.id === this.player.store.get().currentId);
    const nextItem = queue[idx + 1];
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
    const { quality } = this.store.get();
    const policy = policyFor(kind, quality, {
      voiceProcessing: settingsStore.get().voiceProcessing,
    });
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
    this.capture?.stop();
    this.capture = null;
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

  private async publishCurrent(): Promise<void> {
    const { source, quality } = this.store.get();
    const policy = policyFor(source, quality, {
      voiceProcessing: settingsStore.get().voiceProcessing,
    });
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

  // ---- sync --------------------------------------------------------------

  private pushSync(): void {
    if (this.store.get().phase !== 'ready') return;
    const { source, live, captureLabel } = this.store.get();
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
      });
    }
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
    if (this.disposed) return;
    this.disposed = true;
    this.disposer.dispose();
    this.releaseCapture();
    await this.conn.disconnect();
    this.player.dispose();
    this.library.clear();
  }
}
