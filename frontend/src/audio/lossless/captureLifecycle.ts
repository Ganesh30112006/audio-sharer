/**
 * Capture lifecycle with generation safety.
 *
 * One long-lived capture node per AudioContext: start/stop are generations on
 * that node rather than new nodes, so every block's position comes from ONE
 * timeline (separately constructed processors were measured to disagree about
 * `currentFrame` by a device batch).
 *
 * Invariants:
 *  - every start() creates a new generation; stop() invalidates it at once,
 *    even while start() is still awaiting node creation;
 *  - an awaited step whose generation is no longer current never attaches;
 *  - at most one source is connected and one generation is capturing;
 *  - blocks from any other generation are rejected by the owner and counted
 *    as an explicit interruption (never silently discarded).
 */
export interface CaptureNodeHandle {
  /** Sends a control message to the capture processor. */
  post(msg: { cmd: 'start'; gen: number; bitDepth: number; blockFrames: number } | { cmd: 'stop'; gen: number }): void;
  connect(source: AudioNode): void;
  disconnect(source: AudioNode): void;
  dispose(): void;
}

export type NodeFactory<Ctx> = (ctx: Ctx, onMessage: (data: unknown) => void) => Promise<CaptureNodeHandle>;

interface Active<Ctx> {
  gen: number;
  ctx: Ctx;
  source: AudioNode;
  bitDepth: number;
}

export class CaptureLifecycle<Ctx extends object> {
  private gen = 0;
  private nodes = new Map<Ctx, Promise<CaptureNodeHandle>>();
  private ready = new Map<Ctx, CaptureNodeHandle>();
  private active: Active<Ctx> | null = null;

  constructor(
    private readonly factory: NodeFactory<Ctx>,
    private readonly onBlock: (data: unknown, ctx: Ctx) => void,
  ) {}

  /** The only generation whose blocks may enter the pipeline (0 = none). */
  get currentGeneration(): number {
    return this.active?.gen ?? 0;
  }

  get activeContext(): Ctx | null {
    return this.active?.ctx ?? null;
  }

  isActive(ctx: Ctx, source: AudioNode, bitDepth: number): boolean {
    const a = this.active;
    return !!a && a.ctx === ctx && a.source === source && a.bitDepth === bitDepth;
  }

  /**
   * Starts capturing `source` into a new generation. Resolves with the
   * generation number, or null if a later start()/stop() superseded it.
   */
  async start(ctx: Ctx, source: AudioNode, bitDepth: number, blockFrames: number): Promise<number | null> {
    this.stop();
    const gen = ++this.gen;
    let pending = this.nodes.get(ctx);
    if (!pending) {
      pending = this.factory(ctx, (data) => this.onBlock(data, ctx));
      this.nodes.set(ctx, pending);
      pending.then(
        (h) => this.ready.set(ctx, h),
        () => this.nodes.delete(ctx),
      );
    }
    let handle: CaptureNodeHandle;
    try {
      handle = await pending;
    } catch (err) {
      if (gen !== this.gen) return null;
      throw err;
    }
    if (gen !== this.gen) return null; // superseded while awaiting: attach nothing
    handle.connect(source);
    handle.post({ cmd: 'start', gen, bitDepth, blockFrames });
    this.active = { gen, ctx, source, bitDepth };
    return gen;
  }

  /** Stops the active generation immediately; also cancels a start() in progress. */
  stop(): void {
    this.gen++;
    const a = this.active;
    this.active = null;
    if (!a) return;
    const h = this.ready.get(a.ctx);
    if (!h) return;
    h.post({ cmd: 'stop', gen: a.gen });
    h.disconnect(a.source);
  }

  /** Releases every node (e.g. when the owner is disposed or a context closes). */
  async dispose(): Promise<void> {
    this.stop();
    const all = [...this.nodes.values()];
    this.nodes.clear();
    this.ready.clear();
    for (const p of all) {
      try {
        (await p).dispose();
      } catch {
        // creation failed: nothing to release
      }
    }
  }

  /** Releases cached nodes whose context matches `isDead` (e.g. closed contexts). */
  prune(isDead: (ctx: Ctx) => boolean): void {
    for (const ctx of [...this.nodes.keys()]) if (isDead(ctx)) this.forget(ctx);
  }

  /** Number of contexts with a (pending or ready) capture node. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Drops the cached node for a context that is being closed. */
  forget(ctx: Ctx): void {
    if (this.active?.ctx === ctx) this.stop();
    const p = this.nodes.get(ctx);
    this.nodes.delete(ctx);
    this.ready.delete(ctx);
    void p?.then((h) => h.dispose()).catch(() => undefined);
  }
}
