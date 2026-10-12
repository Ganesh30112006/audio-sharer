/**
 * Integration harness for the lossless pipeline (test-only page).
 *
 * Real components: LosslessSender (capture AudioWorklet + codec Web Worker +
 * SendPipeline) and LosslessReceiver (ReceivePipeline + codec Web Worker +
 * playback AudioWorklet). The only simulated piece is the transport, so tests
 * can impose throughput limits, stalls and session restarts in real time.
 *
 * Verification: the source is a deterministic integer signal; every decoded
 * block is compared sample-for-sample with the source at the position given
 * by its firstFrame, so bit-exactness is checked across gaps too.
 */
import { LosslessReceiver } from '../src/audio/lossless/LosslessReceiver';
import { LosslessSender } from '../src/audio/lossless/LosslessSender';

export interface HarnessOptions {
  seconds: number;
  rate: number;
  bits: 16 | 24;
  /** Source channel count (default 2). */
  channels?: number;
  /** Restart the sender every N ms (lifecycle soak). */
  restartEveryMs?: number;
  /** Link segments; outside them the link is unlimited. kbps 0 = stalled. */
  link?: Array<{ fromMs: number; toMs: number; kbps: number }>;
  /** Restart the sender (stop + start = new generation) at these times. */
  restartSenderAtMs?: number[];
  /** Restart the receiver's playback graph at these times. */
  restartReceiverAtMs?: number[];
  /**
   * Test-only UNRELIABLE transport: swap every Nth packet with the next one.
   * The default transport is an ordered reliable FIFO like the data channel.
   */
  reorderEvery?: number;
}

function sourceSample(i: number, ch: number, bits: number, rate: number): number {
  const t = i / rate;
  const v =
    0.3 * Math.sin(2 * Math.PI * 220 * t + ch) +
    0.12 * Math.sin(2 * Math.PI * 1763 * t) +
    0.002 * Math.sin(i * 12.9898 + ch * 78.233); // noise-like, makes alignment unambiguous
  return Math.round(v * (2 ** (bits - 1) - 1));
}

async function run(opts: HarnessOptions) {
  const { rate, bits } = opts;
  const scale = 2 ** (bits - 1);
  const length = Math.ceil(rate * (opts.seconds + 3));
  const C = opts.channels ?? 2;
  const src = Array.from({ length: C }, () => new Int32Array(length));
  const ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  const buffer = ctx.createBuffer(C, length, rate);
  for (let ch = 0; ch < C; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const v = sourceSample(i, ch, bits, rate);
      src[ch]![i] = v;
      data[i] = v / scale; // exact in float32 for <= 24-bit integers
    }
  }

  // ---- transport (the only simulated part) ----
  const t0 = performance.now();
  let linkFree = 0;
  // Assigned below; the transport closure needs a forward reference.
  // eslint-disable-next-line prefer-const
  let receiver: LosslessReceiver;
  const kbpsAt = (ms: number) =>
    opts.link?.find((s) => ms >= s.fromMs && ms < s.toMs)?.kbps ?? Infinity;
  // Ordered, reliable link (like the SCTP data channel): a strict FIFO drained by
  // one timer. Per-packet setTimeouts would reorder packets released together.
  const fifo: Array<{ due: number; payload: Uint8Array; resolve: () => void }> = [];
  let pump: ReturnType<typeof setTimeout> | null = null;
  let sentCount = 0;
  const drain = () => {
    pump = null;
    const now = performance.now() - t0;
    while (fifo.length && fifo[0]!.due <= now) {
      const p = fifo.shift()!;
      p.resolve();
      receiver.push(p.payload);
    }
    if (fifo.length) pump = setTimeout(drain, Math.max(1, fifo[0]!.due - now));
  };
  const send = (payload: Uint8Array<ArrayBuffer>) =>
    new Promise<void>((resolve) => {
      let t = Math.max(performance.now() - t0, linkFree);
      let bitsLeft = payload.length * 8;
      while (bitsLeft > 0) {
        const kbps = kbpsAt(t);
        if (kbps === Infinity) break;
        bitsLeft -= kbps * 5; // kbit/s == bits/ms
        t += 5;
      }
      linkFree = t;
      sentCount++;
      const entry = { due: t + 10, payload: payload.slice(), resolve };
      if (opts.reorderEvery && sentCount % opts.reorderEvery === 0 && fifo.length) {
        // Deliberately violate ordering: this packet overtakes the previous one.
        const prev = fifo.pop()!;
        entry.due = prev.due;
        fifo.push(entry, prev);
      } else {
        fifo.push(entry);
      }
      if (pump === null) pump = setTimeout(drain, Math.max(1, t + 10 - (performance.now() - t0)));
    });

  // ---- verification tap ----
  let offset: number | null = null; // source index = firstFrame + offset
  const v = { blocks: 0, frames: 0, mismatches: 0, unaligned: 0 };
  const mismatchLog: Array<Record<string, number | boolean>> = [];
  // Continuity log: every place the stream position does not continue exactly.
  const jumps: Array<{
    seq: number;
    firstFrame: number;
    expected: number;
    discontinuity: boolean;
    tMs: number;
  }> = [];
  let expectedFrame: number | null = null;
  const firstBlocks: Array<Record<string, number | boolean>> = [];
  receiver = new LosslessReceiver(
    () => performance.now(),
    (meta, pcm) => {
      const n = meta.frames;
      const ch = meta.channels;
      if (expectedFrame !== null && meta.firstFrame !== expectedFrame) {
        jumps.push({
          seq: meta.seq,
          firstFrame: meta.firstFrame,
          expected: expectedFrame,
          discontinuity: meta.discontinuity,
          tMs: Math.round(performance.now() - t0),
        });
      }
      expectedFrame = (meta.firstFrame + n) >>> 0;
      if (firstBlocks.length < 4)
        firstBlocks.push({
          seq: meta.seq,
          firstFrame: meta.firstFrame,
          frames: n,
          ch,
          disc: meta.discontinuity,
        });
      const got = (i: number, c: number) => Math.round(pcm[i * ch + c]! * scale);
      if (ch !== C) {
        v.mismatches += n * ch; // layout must match the source
        return;
      }
      if (offset === null) {
        // Align once on the first block that is entirely signal (not leading silence).
        for (let i = 0; i < n * ch; i++) if (pcm[i] === 0) return;
        for (let k = 0; k < length - n && offset === null; k++) {
          let ok = true;
          for (let i = 0; i < n && ok; i++)
            for (let c = 0; c < ch && ok; c++) ok = src[c]![k + i] === got(i, c);
          if (ok) offset = k - meta.firstFrame;
        }
        if (offset === null) {
          v.unaligned++;
          return;
        }
      }
      v.blocks++;
      for (let i = 0; i < n; i++) {
        const idx = meta.firstFrame + i + offset;
        for (let c = 0; c < ch; c++) {
          // Outside the source (before start / after end) the stream must be digital silence.
          const want = idx < 0 || idx >= length ? 0 : src[c]![idx]!;
          if (got(i, c) !== want) {
            v.mismatches++;
            if (mismatchLog.length < 3)
              mismatchLog.push({
                seq: meta.seq,
                firstFrame: meta.firstFrame,
                i,
                c,
                got: got(i, c),
                want,
              });
          }
        }
        if (idx >= 0 && idx < length) v.frames++;
      }
    },
  );
  const audio = new Audio();
  receiver.events.on('stream', (s) => {
    audio.srcObject = s;
    if (s) void audio.play().catch(() => undefined);
  });

  const sender = new LosslessSender(send, () => performance.now());
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  // Keep the source pulled by the graph independently of capture, like the
  // app's file tap (which always feeds the monitor path). Chromium does not
  // advance an AudioBufferSourceNode that has no connected outputs, so a
  // capture restart would otherwise stall the source and shift its timeline.
  const pull = ctx.createGain();
  pull.gain.value = 0;
  node.connect(pull).connect(ctx.destination);
  await sender.start(ctx, node, bits);
  node.start();
  await ctx.resume();

  // ---- scheduled restarts + sampling ----
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  for (const ms of opts.restartSenderAtMs ?? []) {
    timers.push(
      setTimeout(() => {
        sender.stop();
        void sender.start(ctx, node, bits);
      }, ms),
    );
  }
  for (const ms of opts.restartReceiverAtMs ?? [])
    timers.push(setTimeout(() => receiver.stop(), ms));
  let restartTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.restartEveryMs) {
    restartTimer = setInterval(() => {
      sender.stop();
      void sender.start(ctx, node, bits);
    }, opts.restartEveryMs);
  }

  const samples: Array<Record<string, number>> = [];
  const peak = { sendBlocks: 0, sendBytes: 0, oldestAgeMs: 0, decodeBlocks: 0, heapMB: 0 };
  const sampler = setInterval(() => {
    const s = sender.pipelineStats();
    const r = receiver.pipelineStats();
    peak.sendBlocks = Math.max(peak.sendBlocks, s.sendQueue.blocks, s.encodeQueue.blocks);
    peak.sendBytes = Math.max(peak.sendBytes, s.sendQueue.bytes);
    if (s.state === 'streaming')
      peak.oldestAgeMs = Math.max(
        peak.oldestAgeMs,
        s.sendQueue.oldestAgeMs,
        s.encodeQueue.oldestAgeMs,
      );
    peak.decodeBlocks = Math.max(peak.decodeBlocks, r.decodeQueue.blocks);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) peak.heapMB = Math.max(peak.heapMB, mem.usedJSHeapSize / 2 ** 20);
    samples.push({
      t: Math.round(performance.now() - t0),
      sendQ: s.sendQueue.blocks,
      encQ: s.encodeQueue.blocks,
      decQ: r.decodeQueue.blocks,
      bufferMs: receiver.stats.get().bufferMs,
    });
  }, 100);

  await new Promise((r) => setTimeout(r, opts.seconds * 1000));
  // Snapshot live-stream figures before stopping (stopping itself drains playback).
  const live = { ...receiver.stats.get() };
  const liveSender = { ...sender.stats.get() };
  const liveCauses = sender.pipelineStats().recent.map((i) => i.cause);
  // Stop capture, then let everything in flight drain before accounting.
  sender.stop();
  node.stop();
  for (const t of timers) clearTimeout(t);
  if (restartTimer !== null) clearInterval(restartTimer);
  for (let i = 0; i < 100; i++) {
    const s = sender.pipelineStats();
    const r = receiver.pipelineStats();
    if (
      s.sendQueue.blocks === 0 &&
      s.encodeQueue.blocks === 0 &&
      r.decodeQueue.blocks === 0 &&
      performance.now() - t0 > linkFree + 100
    )
      break;
    await new Promise((res) => setTimeout(res, 100));
  }
  await new Promise((res) => setTimeout(res, 700)); // final worklet stats report
  clearInterval(sampler);

  const s = sender.pipelineStats();
  const r = receiver.pipelineStats();
  const rs = receiver.stats.get();
  const ss = sender.stats.get();
  void rs;
  const result = {
    verify: v,
    jumps: jumps.slice(0, 20),
    firstBlocks,
    mismatchLog,
    captureDiag: sender.captureDiag,
    sender: {
      capturedFrames: s.capturedFrames,
      captureGapFrames: s.captureGapFrames,
      encodedFrames: s.encodedFrames,
      sentFrames: s.sentFrames,
      droppedFrames: s.droppedFrames,
      interruptions: s.interruptions,
      interruptedMs: Math.round(s.interruptedMs),
      causes: s.recent.map((i) => i.cause),
      /** Interruptions recorded while streaming (excludes the final stop). */
      liveCauses,
      blocksSent: s.blocksSent,
      kbps: liveSender.kbps,
      encoderUtilization: liveSender.encoderUtilization,
      offMainThread: ss.offMainThread,
    },
    receiver: {
      deliveredFrames: rs.deliveredFrames,
      decodedFrames: rs.decodedFrames,
      playedFrames: rs.playedFrames,
      silenceFrames: rs.silenceFrames,
      skippedFrames: rs.skippedFrames,
      repeatedFrames: rs.repeatedFrames,
      bufferedFrames: rs.bufferedFrames,
      droppedFrames: r.droppedFrames,
      announcedGaps: r.announcedGaps,
      unexpectedGaps: r.unexpectedGaps,
      stale: r.stale,
      duplicates: r.duplicates,
      corrupt: r.corrupt,
      // Outages while streaming (the final drain after stop is excluded).
      outages: live.outages,
      outageMs: live.outageMs,
      lastRecoveryMs: live.lastRecoveryMs,
      bufferMs: live.bufferMs,
      kbps: live.kbps,
      maxTransitMs: r.maxTransitMs,
      decoderUtilization: live.decoderUtilization,
      liveSilenceFrames: live.silenceFrames,
    },
    peak,
    samples,
  };
  sender.dispose();
  receiver.dispose();
  audio.srcObject = null;
  await ctx.close();
  return result;
}

(window as unknown as { runHarness: typeof run }).runHarness = run;
document.body.dataset.ready = 'true';
