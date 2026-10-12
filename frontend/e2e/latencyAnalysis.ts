/**
 * Turns host + listener latency traces (src/audio/lossless/latencyTrace.ts)
 * into a per-stage breakdown. Every stage is computed inside one clock
 * domain; the only cross-device stage (transport) goes through both sides'
 * server-clock offsets and carries their combined uncertainty.
 */
export interface SideDump {
  cols: string[];
  seq: number[];
  rows: number[][];
  meta: { timeOrigin: number; sampleRate?: number; baseLatency?: number; outputLatency?: number };
  longTasks: Array<[number, number]>;
}

export interface Dist {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function dist(values: number[]): Dist {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p: number) =>
    v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]! : NaN;
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    n: v.length,
    min: r(v.length ? v[0]! : NaN),
    p50: r(q(50)),
    p95: r(q(95)),
    p99: r(q(99)),
    max: r(v.length ? v[v.length - 1]! : NaN),
    mean: r(v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN),
  };
}

type Row = Record<string, number>;

function rowsOf(d: SideDump): Map<number, Row> {
  const m = new Map<number, Row>();
  d.seq.forEach((seq, i) => {
    const r: Row = { seq };
    d.cols.forEach((c, j) => (r[c] = d.rows[i]![j]!));
    m.set(seq, r);
  });
  return m;
}

/** Stages for one block's first frame, ms. Domain noted per stage. */
export const STAGES = [
  'formation', // HA: the first frame waits for the block to fill (frames / rate)
  'captureToPage', // HA->H mapped: block complete on the render clock -> host page thread
  'encodeWait', // H: encode queue + worker hand-off, excluding encode compute
  'encode', // worker compute
  'sendCall', // H: publishData() call until it resolved
  'transport', // server clock: send call (host) -> message on the listener page
  'decodeWait', // L: decode queue + worker hand-off, excluding decode compute
  'decode', // worker compute
  'pageToWorklet', // L->LA mapped: posted on the page -> received on the render thread
  'buffer', // LA: arrival in the worklet -> first frame rendered (intentional buffering)
] as const;
export type Stage = (typeof STAGES)[number];

export interface Analysis {
  blocks: { traced: number; analysed: number; notAdmitted: number; neverPlayed: number };
  /**
   * Silence inserted between consecutive played blocks (listener render
   * clock) inside the analysis window: each gap is one outage, and its length
   * is the time until audio played again (recovery).
   */
  outages: { count: number; totalMs: number; recoveryMs: Dist };
  stages: Record<Stage, Dist>;
  /**
   * Sum of the stages per block (first frame, host render clock to listener
   * render clock). The independent end-to-end check is the onset measurement.
   */
  pipeline: Dist;
  /**
   * Buffered audio left when each block reached the worklet (= what protected
   * playback from an underrun at that moment), and its minimum per 10 s.
   */
  cushion: { atArrival: Dist; min10s: Dist };
  clockUncertaintyMs: number;
  outputLatencyReportedMs: { host: number | null; listener: number | null };
  queues: Record<string, Dist>;
  jitter: {
    /** |inter-arrival - block duration| at the listener page. */
    interArrivalDev: Dist;
    /** Share of consecutive arrivals < 1 ms apart (bunched delivery). */
    bunchedShare: number;
    /** Spread (max - min) of arrival offset vs the stream timeline, per 10 s window. */
    listenerArrivalSpread10s: Dist;
    /** Same spread for blocks reaching the host page thread (production side). */
    hostCaptureSpread10s: Dist;
    /** Same spread for blocks reaching the playback worklet (what the buffer must cover). */
    workletArrivalSpread10s: Dist;
  };
  longTasks: {
    host: { count: number; totalMs: number };
    listener: { count: number; totalMs: number };
  };
  /** Stage values of the slowest 1% of blocks (by pipeline sum): what the tail is made of. */
  tail: Record<Stage, number>;
  /**
   * Blocks that reached the worklet with less than one render quantum
   * buffered (an underrun was happening or imminent), with how late that
   * block was in each stage relative to the stage's median.
   */
  lowCushion: Array<{
    tSec: number;
    cushionMs: number;
    /** Gap since the previous block reached the worklet (render clock). */
    workletGapMs: number;
    excess: Partial<Record<Stage, number>>;
  }>;
}

function windowMin(points: Array<[number, number]>, windowMs = 10_000): number[] {
  const out: number[] = [];
  if (!points.length) return out;
  let start = points[0]![0];
  let lo = Infinity;
  for (const [t, v] of points) {
    if (t - start >= windowMs) {
      out.push(lo);
      start = t;
      lo = Infinity;
    }
    lo = Math.min(lo, v);
  }
  return out;
}

function windowSpread(points: Array<[number, number]>, windowMs = 10_000): number[] {
  // points: [timeMs, offsetMs]
  const out: number[] = [];
  if (!points.length) return out;
  let start = points[0]![0];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [t, o] of points) {
    if (t - start >= windowMs) {
      if (hi >= lo) out.push(hi - lo);
      start = t;
      lo = Infinity;
      hi = -Infinity;
    }
    lo = Math.min(lo, o);
    hi = Math.max(hi, o);
  }
  return out;
}

export function analyse(
  host: SideDump,
  listener: SideDump,
  skipFirstMs = 5000,
  skipLastMs = 3000,
): Analysis {
  const H = rowsOf(host);
  const L = rowsOf(listener);
  const rate = listener.meta.sampleRate ?? host.meta.sampleRate ?? 48_000;
  const stageVals: Record<Stage, number[]> = Object.fromEntries(
    STAGES.map((s) => [s, []]),
  ) as never;
  const perBlock: Array<Record<Stage, number> & { sum: number }> = [];
  const pipeline: number[] = [];
  const cushionPts: Array<[number, number]> = [];
  const unc: number[] = [];
  let notAdmitted = 0;
  let neverPlayed = 0;
  let traced = 0;
  const captures = [...H.values()].map((r) => r.captureH!).filter(Number.isFinite);
  const firstCapture = Math.min(...captures);
  const lastCapture = Math.max(...captures);
  const queues: Record<string, number[]> = {
    encodeQueueBlocks: [],
    sendQueueBlocks: [],
    oldestQueuedMs: [],
    decodeQueueBlocks: [],
    targetMs: [],
  };
  const listenerArrivals: Array<[number, number]> = [];
  const hostCaptures: Array<[number, number]> = [];
  const workletArrivals: Array<[number, number]> = [];

  const low: Array<{ seq: number; t: number; cushion: number; s: Record<Stage, number> }> = [];
  for (const [seq, h] of H) {
    traced++;
    if (h.admitted === 0) notAdmitted++;
    const l = L.get(seq);
    if (!l || h.captureH! - firstCapture < skipFirstMs || h.captureH! > lastCapture - skipLastMs)
      continue;
    if (l.firstFrame !== h.firstFrame) continue; // not the same block (should not happen)
    if (Number.isNaN(l.playLA!) && Number.isFinite(l.arriveLA!)) neverPlayed++;
    const blockMs = (h.frames! / rate) * 1000;
    const s: Record<Stage, number> = {
      formation: blockMs,
      captureToPage: h.captureH! - (h.blockEndHA! + h.mapOffsetHA!),
      encodeWait: h.encodedH! - h.captureH! - h.encodeBusyMs!,
      encode: h.encodeBusyMs!,
      sendCall: h.sendDoneH! - h.sendCallH!,
      transport: l.receiveL! + l.serverOffsetL! - (h.sendCallH! + h.serverOffsetH!),
      decodeWait: l.decodedL! - l.receiveL! - l.decodeBusyMs!,
      decode: l.decodeBusyMs!,
      pageToWorklet: l.arriveLA! + l.mapOffsetLA! - l.postL!,
      buffer: l.playLA! - l.arriveLA!,
    };
    queues.encodeQueueBlocks!.push(h.encodeQueueBlocks!);
    queues.sendQueueBlocks!.push(h.sendQueueAtCall!);
    queues.oldestQueuedMs!.push(h.oldestQueuedMs!);
    queues.decodeQueueBlocks!.push(l.decodeQueueBlocks!);
    queues.targetMs!.push((l.targetFrames! / rate) * 1000);
    const startMs = (h.firstFrame! / rate) * 1000;
    listenerArrivals.push([l.receiveL!, l.receiveL! - startMs]);
    hostCaptures.push([h.captureH!, h.captureH! - startMs]);
    if (Number.isFinite(l.arriveLA!)) workletArrivals.push([l.arriveLA!, l.arriveLA! - startMs]);
    // Only the sendCall stage overlaps nothing; it runs after encoding and
    // before the message leaves, and transport starts at the call. Sum excludes it.
    const complete = STAGES.every((k) => Number.isFinite(s[k]));
    if (!complete) continue;
    for (const k of STAGES) stageVals[k].push(s[k]);
    const sum = STAGES.reduce((a, k) => a + (k === 'sendCall' ? 0 : s[k]), 0);
    pipeline.push(sum);
    perBlock.push({ ...s, sum });
    cushionPts.push([l.arriveLA!, (l.bufferFramesAtArrive! / rate) * 1000]);
    const cushion = (l.bufferFramesAtArrive! / rate) * 1000;
    if (cushion < (128 / rate) * 1000 && low.length < 200)
      low.push({ seq, t: (h.captureH! - firstCapture) / 1000, cushion, s });
    unc.push(h.serverUncMs! + l.serverUncMs!);
  }

  // Inter-arrival at the listener page, consecutive accepted blocks.
  const seqs = [...L.keys()].sort((a, b) => a - b);
  const dev: number[] = [];
  let bunched = 0;
  let pairs = 0;
  for (let i = 1; i < seqs.length; i++) {
    const a = L.get(seqs[i - 1]!)!;
    const b = L.get(seqs[i]!)!;
    if (
      seqs[i]! !== seqs[i - 1]! + 1 ||
      !Number.isFinite(a.receiveL!) ||
      !Number.isFinite(b.receiveL!)
    )
      continue;
    const d = b.receiveL! - a.receiveL!;
    const blockMs = (b.frames! / rate) * 1000;
    dev.push(Math.abs(d - blockMs));
    if (d < 1) bunched++;
    pairs++;
  }

  // Outages: silence between consecutive played blocks, inside the window.
  const plays = seqs
    .map((q) => L.get(q)!)
    .filter((r) => Number.isFinite(r.playLA!) && Number.isFinite(r.arriveLA!));
  const firstArrive = plays.length ? plays[0]!.arriveLA! : 0;
  const lastArrive = plays.length ? plays[plays.length - 1]!.arriveLA! : 0;
  const gaps: number[] = [];
  for (let i = 1; i < plays.length; i++) {
    const a = plays[i - 1]!;
    const b = plays[i]!;
    if (b.seq! !== a.seq! + 1) continue;
    if (b.arriveLA! - firstArrive < skipFirstMs || b.arriveLA! > lastArrive - skipLastMs) continue;
    const gap = b.playLA! - a.playLA! - (a.frames! / rate) * 1000;
    if (gap > 1) gaps.push(gap);
  }

  perBlock.sort((a, b) => b.sum - a.sum);
  const worst = perBlock.slice(0, Math.max(1, Math.floor(perBlock.length / 100)));
  const tail = Object.fromEntries(
    STAGES.map((k) => [
      k,
      Math.round((worst.reduce((a, b) => a + b[k], 0) / worst.length) * 100) / 100,
    ]),
  ) as Record<Stage, number>;
  const med = Object.fromEntries(STAGES.map((k) => [k, dist(stageVals[k]).p50])) as Record<
    Stage,
    number
  >;
  const lowCushion = low.slice(0, 40).map(({ seq, t, cushion, s: st }) => {
    const prev = L.get(seq - 1);
    const cur = L.get(seq)!;
    const excess: Partial<Record<Stage, number>> = {};
    for (const k of STAGES) {
      const e = st[k] - med[k];
      if (Number.isFinite(e) && Math.abs(e) >= 2) excess[k] = Math.round(e * 10) / 10;
    }
    return {
      tSec: Math.round(t * 10) / 10,
      cushionMs: Math.round(cushion * 10) / 10,
      workletGapMs: prev ? Math.round((cur.arriveLA! - prev.arriveLA!) * 10) / 10 : NaN,
      excess,
    };
  });
  const lt = (d: SideDump) => ({
    count: d.longTasks.length,
    totalMs: Math.round(d.longTasks.reduce((a, [, dur]) => a + dur, 0)),
  });
  const out = (d: SideDump) =>
    d.meta.outputLatency !== undefined || d.meta.baseLatency !== undefined
      ? Math.round(((d.meta.baseLatency ?? 0) + (d.meta.outputLatency ?? 0)) * 1000 * 100) / 100
      : null;

  return {
    blocks: { traced, analysed: pipeline.length, notAdmitted, neverPlayed },
    outages: {
      count: gaps.length,
      totalMs: Math.round(gaps.reduce((x, y) => x + y, 0)),
      recoveryMs: dist(gaps),
    },
    stages: Object.fromEntries(STAGES.map((k) => [k, dist(stageVals[k])])) as Record<Stage, Dist>,
    pipeline: dist(pipeline),
    cushion: {
      atArrival: dist(cushionPts.map(([, c]) => c)),
      min10s: dist(windowMin(cushionPts)),
    },
    clockUncertaintyMs: dist(unc).max,
    outputLatencyReportedMs: { host: out(host), listener: out(listener) },
    queues: Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, dist(v)])),
    jitter: {
      interArrivalDev: dist(dev),
      bunchedShare: pairs ? Math.round((bunched / pairs) * 1000) / 1000 : NaN,
      listenerArrivalSpread10s: dist(windowSpread(listenerArrivals)),
      hostCaptureSpread10s: dist(windowSpread(hostCaptures)),
      workletArrivalSpread10s: dist(windowSpread(workletArrivals)),
    },
    longTasks: { host: lt(host), listener: lt(listener) },
    tail,
    lowCushion,
  };
}
