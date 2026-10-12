import { describe, expect, it, vi } from 'vitest';
import { CaptureLifecycle, type CaptureNodeHandle } from '../../src/audio/lossless/captureLifecycle';
import { SendPipeline } from '../../src/audio/lossless/pipeline';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake capture node that records control messages and connections. */
function fakeNode() {
  const posts: Array<{ cmd: string; gen: number }> = [];
  const connected = new Set<AudioNode>();
  let disposed = false;
  const handle: CaptureNodeHandle = {
    post: (m) => posts.push(m),
    connect: (s) => connected.add(s),
    disconnect: (s) => connected.delete(s),
    dispose: () => {
      disposed = true;
    },
  };
  return { handle, posts, connected, get disposed() {
    return disposed;
  } };
}

const ctxA = { id: 'A' };
const ctxB = { id: 'B' };
const src1 = { id: 1 } as unknown as AudioNode;
const src2 = { id: 2 } as unknown as AudioNode;

/** Producers that are currently capturing according to the control messages they received. */
function activeProducers(posts: Array<{ cmd: string; gen: number }>): number[] {
  const active = new Set<number>();
  for (const p of posts) {
    if (p.cmd === 'start') {
      active.clear(); // the processor runs one generation at a time
      active.add(p.gen);
    } else active.delete(p.gen);
  }
  return [...active];
}

describe('CaptureLifecycle', () => {
  it('stop() during start(): nothing attaches after cancellation', async () => {
    const d = deferred<CaptureNodeHandle>();
    const node = fakeNode();
    const lc = new CaptureLifecycle<object>(() => d.promise, () => undefined);
    const started = lc.start(ctxA, src1, 24, 960);
    lc.stop();
    d.resolve(node.handle);
    expect(await started).toBeNull();
    expect(node.connected.size).toBe(0);
    expect(node.posts).toEqual([]);
    expect(lc.currentGeneration).toBe(0);
  });

  it('two rapid start() calls: only the latest generation attaches', async () => {
    const d = deferred<CaptureNodeHandle>();
    const node = fakeNode();
    const factory = vi.fn(() => d.promise);
    const lc = new CaptureLifecycle<object>(factory, () => undefined);
    const a = lc.start(ctxA, src1, 24, 960);
    const b = lc.start(ctxA, src2, 24, 960);
    d.resolve(node.handle);
    expect(await a).toBeNull();
    const gen = await b;
    expect(gen).not.toBeNull();
    expect([...node.connected]).toEqual([src2]);
    expect(node.posts.filter((p) => p.cmd === 'start').map((p) => p.gen)).toEqual([gen]);
    expect(factory).toHaveBeenCalledTimes(1); // one node per context
  });

  it('node creation failure for a cancelled start is swallowed; for the current start it surfaces', async () => {
    const d1 = deferred<CaptureNodeHandle>();
    const lc = new CaptureLifecycle<object>(() => d1.promise, () => undefined);
    const cancelled = lc.start(ctxA, src1, 24, 960);
    lc.stop();
    d1.reject(new Error('boom'));
    expect(await cancelled).toBeNull();
    const d2 = deferred<CaptureNodeHandle>();
    const lc2 = new CaptureLifecycle<object>(() => d2.promise, () => undefined);
    const current = lc2.start(ctxA, src1, 24, 960);
    d2.reject(new Error('boom'));
    await expect(current).rejects.toThrow('boom');
  });

  it('stop() during node creation, then dispose(): partially created resources are released', async () => {
    const d = deferred<CaptureNodeHandle>();
    const node = fakeNode();
    const lc = new CaptureLifecycle<object>(() => d.promise, () => undefined);
    const p = lc.start(ctxA, src1, 24, 960);
    lc.stop();
    d.resolve(node.handle);
    await p;
    await lc.dispose();
    expect(node.disposed).toBe(true);
    expect(lc.nodeCount).toBe(0);
  });

  it('repeated restart cycles never leave more than one active producer or connection', async () => {
    const nodes = new Map<object, ReturnType<typeof fakeNode>>();
    const lc = new CaptureLifecycle<object>(async (ctx) => {
      const n = fakeNode();
      nodes.set(ctx, n);
      return n.handle;
    }, () => undefined);
    const pending: Array<Promise<number | null>> = [];
    for (let i = 0; i < 200; i++) {
      const ctx = i % 7 === 0 ? ctxB : ctxA; // also switches contexts (sample-rate changes)
      pending.push(lc.start(ctx, i % 2 ? src1 : src2, i % 3 ? 24 : 16, 960));
      if (i % 5 === 0) lc.stop();
      if (i % 4 === 0) await Promise.resolve();
    }
    const gens = (await Promise.all(pending)).filter((g) => g !== null);
    expect(gens.length).toBeGreaterThan(0);
    let producers = 0;
    let connections = 0;
    for (const n of nodes.values()) {
      producers += activeProducers(n.posts).length;
      connections += n.connected.size;
    }
    expect(producers).toBeLessThanOrEqual(1);
    expect(connections).toBeLessThanOrEqual(1);
    expect(lc.currentGeneration === 0 ? 0 : 1).toBe(producers);
  });
});

describe('pipeline boundary: stale capture generations', () => {
  it('rejects frames from a stopped/stale producer with an explicit, attributed interruption', () => {
    const sent: number[] = [];
    const p = new SendPipeline({
      now: () => 0,
      serverNow: () => 0,
      encode: (job) => sent.push(job.block.seq),
      send: () => Promise.resolve(),
    });
    p.capture(new Int32Array(960 * 2), 2, 48_000, 24, 0);
    p.rejectCapture(320, 7, 960, 'stale-capture');
    const s = p.stats();
    expect(s.capturedFrames).toBe(960 + 320);
    expect(s.droppedFrames).toBe(320);
    expect(s.recent.at(-1)).toMatchObject({ cause: 'stale-capture', detail: { generation: 7, firstFrame: 960, frames: 320 } });
    expect(sent).toEqual([0]);
  });

  it('restart with encoder work in flight: every block is delivered or explicitly interrupted', async () => {
    const jobs: Array<{ gen: number; seq: number }> = [];
    const p = new SendPipeline({
      now: () => 0,
      serverNow: () => 0,
      encode: (job) => jobs.push({ gen: job.gen, seq: job.block.seq }),
      send: () => Promise.resolve(),
    });
    for (let i = 0; i < 5; i++) p.capture(new Int32Array(960 * 2), 2, 48_000, 24);
    p.reset(); // restart while 5 blocks are still encoding
    for (const j of jobs) p.encoded(j.gen, j.seq, new Uint8Array(10)); // late replies from the old generation
    await Promise.resolve();
    const s = p.stats();
    expect(s.sentFrames).toBe(0); // nothing stale was sent
    expect(s.capturedFrames).toBe(5 * 960);
    expect(s.droppedFrames).toBe(5 * 960);
    expect(s.recent.at(-1)!.cause).toBe('session-reset');
  });
});
