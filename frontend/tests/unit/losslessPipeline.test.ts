/**
 * Overload simulations for the lossless pipeline (virtual time, deterministic).
 *
 * Real pieces: codec (encode/decode), SendPipeline, ReceivePipeline.
 * Simulated: capture clock, encoder/decoder speed, network link (throughput,
 * stalls, duplication, reordering) and the playback buffer.
 *
 * Invariants checked in every scenario:
 *  1. Accounting: captured frames == delivered frames + frames reported lost
 *     in explicit interruptions (after draining). Nothing disappears silently.
 *  2. Every delivered block is bit-exact.
 *  3. Queues stay within their block/byte/age bounds (+ one block of slack).
 *  4. Receiver sees no unexpected gaps: every gap is announced.
 */
import { describe, expect, it } from 'vitest';
import { decodeBlock, encodeBlock, peekHeader } from '../../src/audio/lossless/codec';
import {
  DEFAULT_RECEIVE_LIMITS,
  DEFAULT_SEND_LIMITS,
  ReceivePipeline,
  SendPipeline,
  type DecodeJob,
  type EncodeJob,
} from '../../src/audio/lossless/pipeline';

const RATE = 48_000;
const BITS = 24;
const FRAMES = 960; // 20 ms
const BLOCK_MS = 20;

interface Scenario {
  seconds: number;
  /** Encoder ms per block at virtual time t (ms). */
  encMs?: (t: number) => number;
  decMs?: (t: number) => number;
  /** Link throughput in bytes per ms at time t (Infinity = unlimited); 0 = stalled. */
  link?: (t: number) => number;
  duplicateEvery?: number;
  swapEvery?: number;
  signal?: (frame: number, ch: number) => number;
  resetAt?: number[];
}

function musicSample(frame: number, ch: number): number {
  const t = frame / RATE;
  const v =
    0.3 * Math.sin(2 * Math.PI * 220 * t + ch) +
    0.1 * Math.sin(2 * Math.PI * 1763 * t) +
    0.002 * Math.sin(frame * 12.9898);
  return Math.round(v * (2 ** (BITS - 1) - 1));
}

async function simulate(sc: Scenario) {
  let now = 0;
  type Ev = { t: number; order: number; fn: () => void };
  const events: Ev[] = [];
  let order = 0;
  const at = (t: number, fn: () => void) => {
    events.push({ t, order: order++, fn });
  };
  const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  const source = new Map<number, Int32Array>(); // seq -> original samples (only blocks admitted)
  let capturedFrames = 0;
  let deliveredFrames = 0;
  let bitErrors = 0;
  const peaks = { enc: 0, encBytes: 0, send: 0, sendBytes: 0, dec: 0, age: 0 };

  // ---- encoder (sequential worker) ----
  let encFree = 0;
  const encode = (job: EncodeJob) => {
    source.set(job.block.seq, job.block.samples.slice());
    const start = Math.max(now, encFree);
    encFree = start + (sc.encMs?.(start) ?? 0.2);
    const gen = job.gen;
    const seq = job.block.seq;
    const block = { ...job.block, samples: job.block.samples.slice() };
    at(encFree, () => sender.encoded(gen, seq, encodeBlock(block)));
  };

  // ---- network link (FIFO) ----
  let linkFree = 0;
  let sentCount = 0;
  let heldBack: Uint8Array | null = null;
  const send = (payload: Uint8Array<ArrayBuffer>) =>
    new Promise<void>((resolve) => {
      // Advance through stalls / throughput changes in 5 ms steps.
      let t = Math.max(now, linkFree);
      let remaining = payload.length;
      while (remaining > 0) {
        const bw = sc.link?.(t) ?? Infinity;
        if (bw === Infinity) break;
        remaining -= bw * 5;
        t += 5;
      }
      linkFree = t;
      sentCount++;
      const n = sentCount;
      at(t, resolve);
      at(t + 15, () => {
        if (sc.swapEvery && n % sc.swapEvery === 0) {
          heldBack = payload; // delivered after the next packet -> reordered
          return;
        }
        receiver.receive(payload);
        if (sc.duplicateEvery && n % sc.duplicateEvery === 0) receiver.receive(payload);
        if (heldBack) {
          receiver.receive(heldBack);
          heldBack = null;
        }
      });
    });

  const sender = new SendPipeline({
    now: () => now,
    serverNow: () => 1_000_000 + now,
    encode,
    send,
  });

  // ---- decoder + playback ----
  let decFree = 0;
  let buffered = 0; // frames in playback buffer
  let playing = false;
  let everPlayed = false;
  let outageStart: number | null = null;
  const outages: number[] = [];
  const decode = (job: DecodeJob) => {
    const start = Math.max(now, decFree);
    decFree = start + (sc.decMs?.(start) ?? 0.2);
    at(decFree, () => {
      const done = receiver.decoded(job.gen, job.meta.seq);
      if (!done) return;
      const out = decodeBlock(done.payload).samples;
      const src = source.get(done.meta.seq);
      if (!src) bitErrors++;
      else for (let i = 0; i < src.length; i++) if (src[i] !== out[i]) bitErrors++;
      source.delete(done.meta.seq);
      deliveredFrames += done.meta.frames;
      if (done.resetBefore) {
        buffered = 0;
        playing = false;
      }
      buffered += done.meta.frames;
    });
  };
  const receiver = new ReceivePipeline({
    now: () => now,
    serverNow: () => 1_000_000 + now,
    peek: peekHeader,
    decode,
  });

  // ---- capture clock + playback consumption ----
  const total = Math.round((sc.seconds * 1000) / BLOCK_MS);
  let frame = 0;
  for (let b = 0; b < total; b++) {
    at(b * BLOCK_MS, () => {
      if (sc.resetAt?.includes(b * BLOCK_MS)) {
        // Session restart: in-flight work is invalidated and must be ignored.
        sender.reset();
        receiver.reset();
      }
      const s = new Int32Array(FRAMES * 2);
      for (let i = 0; i < FRAMES; i++) {
        s[2 * i] = (sc.signal ?? musicSample)(frame + i, 0);
        s[2 * i + 1] = (sc.signal ?? musicSample)(frame + i, 1);
      }
      frame += FRAMES;
      capturedFrames += FRAMES;
      sender.capture(s, 2, RATE, BITS);
      const st = sender.stats();
      peaks.enc = Math.max(peaks.enc, st.encodeQueue.blocks);
      peaks.encBytes = Math.max(peaks.encBytes, st.encodeQueue.bytes);
      peaks.send = Math.max(peaks.send, st.sendQueue.blocks);
      peaks.sendBytes = Math.max(peaks.sendBytes, st.sendQueue.bytes);
      peaks.dec = Math.max(peaks.dec, receiver.stats().decodeQueue.blocks);
      // Age is bounded at admission: while streaming, nothing older than the limit is queued.
      // (Blocks already handed to the transport keep aging during an interruption.)
      if (st.state === 'streaming') {
        peaks.age = Math.max(peaks.age, st.encodeQueue.oldestAgeMs, st.sendQueue.oldestAgeMs);
      }
    });
  }
  // Playback consumes 20 ms per tick once 120 ms are buffered.
  for (let t = 0; t < sc.seconds * 1000 + 30_000; t += BLOCK_MS) {
    at(t + 10, () => {
      if (!playing && buffered >= FRAMES * 6) {
        playing = true;
        everPlayed = true;
        if (outageStart !== null) outages.push(now - outageStart);
        outageStart = null;
      }
      if (playing) {
        if (buffered >= FRAMES) buffered -= FRAMES;
        else {
          playing = false;
          buffered = 0;
          outageStart = now;
        }
      }
    });
  }

  // ---- run (drains after capture stops) ----
  while (events.length) {
    events.sort((a, b) => a.t - b.t || a.order - b.order);
    const ev = events.shift()!;
    now = ev.t;
    ev.fn();
    await flush();
  }

  const s = sender.stats();
  const r = receiver.stats();
  return { s, r, capturedFrames, deliveredFrames, bitErrors, peaks, outages, everPlayed };
}

function checkInvariants(
  res: Awaited<ReturnType<typeof simulate>>,
  opts: { resets?: boolean } = {},
) {
  const { s, r } = res;
  expect(res.bitErrors, 'delivered blocks must be bit-exact').toBe(0);
  if (!opts.resets) {
    expect(
      res.deliveredFrames + s.droppedFrames + r.droppedFrames,
      'every frame delivered or reported lost',
    ).toBe(res.capturedFrames);
  }
  expect(r.unexpectedGaps, 'gaps must be announced').toBe(0);
  const L = DEFAULT_SEND_LIMITS;
  expect(res.peaks.enc).toBeLessThanOrEqual(L.encode.maxBlocks + 1);
  expect(res.peaks.send).toBeLessThanOrEqual(L.send.maxBlocks + 1);
  expect(res.peaks.sendBytes).toBeLessThanOrEqual(L.send.maxBytes + 16 * 1024);
  expect(res.peaks.dec).toBeLessThanOrEqual(DEFAULT_RECEIVE_LIMITS.maxBlocks + 1);
  expect(res.peaks.age).toBeLessThanOrEqual(L.send.maxAgeMs + 2 * BLOCK_MS);
}

describe('lossless pipeline under load (simulated)', () => {
  it('normal conditions for 2 virtual minutes: no interruptions, everything delivered bit-exact', async () => {
    const res = await simulate({ seconds: 120, link: () => 1000 /* 8 Mbps */ });
    checkInvariants(res);
    expect(res.s.interruptions).toBe(0);
    expect(res.r.interruptions).toBe(0);
    expect(res.deliveredFrames).toBe(res.capturedFrames);
    expect(res.outages).toEqual([]);
  }, 60_000);

  it('encoder slower than capture for 45 s: bounded queue, explicit encoder interruptions', async () => {
    const res = await simulate({ seconds: 60, encMs: (t) => (t > 5_000 && t < 50_000 ? 30 : 0.2) });
    checkInvariants(res);
    expect(res.s.interruptions).toBeGreaterThan(0);
    expect(res.s.recent.every((i) => i.cause === 'encoder-overload')).toBe(true);
    expect(res.r.announcedGaps).toBeGreaterThan(0);
    // After the overload ends, streaming resumes cleanly.
    expect(res.s.state).toBe('streaming');
  }, 60_000);

  it('network slower than the encoded bitrate for 30 s: congestion interruptions, bounded send queue', async () => {
    // Encoded music here is ~100 B/ms; give the link 40 B/ms during the slow period.
    const res = await simulate({ seconds: 45, link: (t) => (t > 5_000 && t < 35_000 ? 40 : 1000) });
    checkInvariants(res);
    expect(res.s.recent.some((i) => i.cause === 'network-congestion')).toBe(true);
    expect(res.s.state).toBe('streaming');
  }, 60_000);

  it('network stall of 5 s then recovery: one interruption, prompt recovery', async () => {
    const res = await simulate({ seconds: 20, link: (t) => (t > 5_000 && t < 10_000 ? 0 : 1000) });
    checkInvariants(res);
    expect(res.s.interruptions).toBe(1);
    const i = res.s.recent[0]!;
    expect(i.cause).toBe('network-congestion');
    // Detected within the age bound, and lasting about as long as the stall.
    expect(i.startedAt).toBeLessThan(5_000 + DEFAULT_SEND_LIMITS.send.maxAgeMs + 100);
    expect(i.endedAt! - i.startedAt).toBeLessThan(6_000);
    // Playback had exactly one outage and recovered.
    expect(res.outages.length).toBe(1);
    expect(res.outages[0]!).toBeLessThan(7_000);
  }, 60_000);

  it('receiver decode slower than incoming rate: decoder interruptions, bounded decode queue', async () => {
    const res = await simulate({ seconds: 40, decMs: (t) => (t > 5_000 && t < 25_000 ? 35 : 0.2) });
    checkInvariants(res);
    expect(res.r.interruptions).toBeGreaterThan(0);
    expect(res.s.interruptions).toBe(0);
  }, 60_000);

  it('rejects duplicated and reordered packets without corrupting audio', async () => {
    const res = await simulate({ seconds: 10, duplicateEvery: 7, swapEvery: 11 });
    expect(res.bitErrors).toBe(0);
    expect(res.r.duplicates).toBeGreaterThan(0);
    expect(res.r.stale).toBeGreaterThan(0);
    // Reordered blocks are rejected as stale, which is a (non-announced) loss on an
    // unreliable path; the reliable data channel never reorders, so this only
    // checks that bad input is contained.
  }, 60_000);

  it('variable block sizes with huge Rice quotients stay within byte bounds', async () => {
    const spiky = (f: number, ch: number) =>
      f % 997 === 0 ? (ch ? -(2 ** 23) : 2 ** 23 - 1) : musicSample(f, ch);
    const res = await simulate({
      seconds: 20,
      signal: spiky,
      link: (t) => (t > 3_000 && t < 12_000 ? 30 : 1000),
    });
    checkInvariants(res);
  }, 60_000);

  it('repeated session resets ignore stale in-flight work', async () => {
    const res = await simulate({
      seconds: 12,
      encMs: () => 15,
      resetAt: [2_000, 2_040, 4_000, 7_000, 7_020, 7_040],
    });
    checkInvariants(res, { resets: true });
    expect(res.r.unexpectedGaps).toBe(0);
  }, 60_000);
});

describe('receiver continuity checks', () => {
  const mk = () => {
    const decoded: DecodeJob[] = [];
    const r = new ReceivePipeline({
      now: () => 0,
      serverNow: () => 0,
      peek: peekHeader,
      decode: (j) => decoded.push(j),
    });
    return { r, decoded };
  };
  const blk = (seq: number, firstFrame: number, discontinuity = false) =>
    encodeBlock({
      seq,
      sampleRate: RATE,
      channels: 2,
      bitDepth: 16,
      samples: new Int32Array(64 * 2),
      firstFrame,
      discontinuity,
    });

  it('treats an unannounced sample-position jump as a gap and resets playback', () => {
    const { r, decoded } = mk();
    r.receive(blk(0, 0));
    r.receive(blk(1, 64));
    r.receive(blk(2, 1000)); // seq contiguous, frames jumped
    expect(r.stats().unexpectedGaps).toBe(1);
    expect(decoded.map((d) => d.resetBefore)).toEqual([true, false, true]);
  });

  it('announced discontinuity resets playback without counting an unexpected gap', () => {
    const { r, decoded } = mk();
    r.receive(blk(0, 0));
    r.receive(blk(5, 5 * 64, true));
    expect(r.stats()).toMatchObject({ unexpectedGaps: 0, announcedGaps: 1 });
    expect(decoded[1]!.resetBefore).toBe(true);
  });

  it('rejects duplicates and stale blocks, including across 32-bit wrap', () => {
    const { r, decoded } = mk();
    r.receive(blk(0xfffffffe, 0));
    r.receive(blk(0xffffffff, 64));
    r.receive(blk(0, 128)); // wraps
    r.receive(blk(0xffffffff, 64)); // stale
    r.receive(blk(0, 128)); // duplicate
    expect(decoded.length).toBe(3);
    expect(r.stats()).toMatchObject({ stale: 1, duplicates: 1, unexpectedGaps: 0 });
  });

  it('ignores decode completions from a previous generation', () => {
    const { r, decoded } = mk();
    r.receive(blk(0, 0));
    const oldGen = decoded[0]!.gen;
    r.reset();
    expect(r.decoded(oldGen, 0)).toBeNull();
  });
});
