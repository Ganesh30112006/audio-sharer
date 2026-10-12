import { describe, expect, it } from 'vitest';
import { analyse, type SideDump } from '../../e2e/latencyAnalysis';
import { RECEIVER_COLS, SENDER_COLS } from '../../src/audio/lossless/latencyTrace';

const RATE = 48_000;
const FRAMES = 480; // 10 ms

/**
 * Synthetic run with known stage values in four unrelated clock domains:
 * host page (H), host render (HA), listener page (L), listener render (LA).
 */
function synth(blocks: number, outageAt: number, outageMs: number) {
  const hostServerOffset = 1_000_000; // server = H + offset
  const listenerServerOffset = 2_000_000; // server = L + offset
  const mapHA = 500; // H = HA + 500
  const mapLA = 700; // L = LA + 700
  const hRows: number[][] = [];
  const lRows: number[][] = [];
  let shift = 0; // playback shift after the outage
  for (let seq = 0; seq < blocks; seq++) {
    const firstFrame = seq * FRAMES;
    const blockEndHA = ((firstFrame + FRAMES) / RATE) * 1000;
    const captureH = blockEndHA + mapHA + 2; // captureToPage 2
    const encodedH = captureH + 0.5 + 0.1; // encodeWait 0.5, encode 0.1
    const sendCallH = encodedH;
    const server = sendCallH + hostServerOffset + 1.5; // transport 1.5
    const receiveL = server - listenerServerOffset;
    const decodedL = receiveL + 0.3 + 0.2; // decodeWait 0.3, decode 0.2
    const arriveLA = decodedL - mapLA + 1; // pageToWorklet 1
    if (seq === outageAt) shift += outageMs;
    const playLA = arriveLA + 40 + shift; // buffer 40 (+ outage)
    const h: Record<string, number> = {
      firstFrame,
      frames: FRAMES,
      blockEndHA,
      captureH,
      mapOffsetHA: mapHA,
      admitted: 1,
      encodeQueueBlocks: 0,
      sendQueueBlocks: 0,
      oldestQueuedMs: 0,
      encodedH,
      encodeBusyMs: 0.1,
      sendCallH,
      sendDoneH: sendCallH + 0.1,
      sendQueueAtCall: 1,
      serverOffsetH: hostServerOffset,
      serverUncMs: 1,
    };
    const l: Record<string, number> = {
      firstFrame,
      frames: FRAMES,
      receiveL,
      accepted: 1,
      decodeQueueBlocks: 1,
      decodedL,
      decodeBusyMs: 0.2,
      postL: decodedL,
      mapOffsetLA: mapLA,
      arriveLA,
      playLA,
      bufferFramesAtArrive: 40 * 48,
      targetFrames: 40 * 48,
      serverOffsetL: listenerServerOffset,
      serverUncMs: 2,
    };
    hRows.push(SENDER_COLS.map((c) => h[c]!));
    lRows.push(RECEIVER_COLS.map((c) => l[c]!));
  }
  const seq = Array.from({ length: blocks }, (_, i) => i);
  const host: SideDump = {
    cols: [...SENDER_COLS],
    seq,
    rows: hRows,
    meta: { timeOrigin: 0, sampleRate: RATE },
    longTasks: [],
  };
  const listener: SideDump = {
    cols: [...RECEIVER_COLS],
    seq,
    rows: lRows,
    meta: { timeOrigin: 0, sampleRate: RATE },
    longTasks: [],
  };
  return { host, listener };
}

describe('latency analysis', () => {
  it('recovers each stage within its own clock domain and the transport via the server clock', () => {
    const { host, listener } = synth(3000, 2000, 0);
    const a = analyse(host, listener);
    expect(a.stages.formation.p50).toBe(10);
    expect(a.stages.captureToPage.p50).toBeCloseTo(2, 6);
    expect(a.stages.encodeWait.p50).toBeCloseTo(0.5, 6);
    expect(a.stages.transport.p50).toBeCloseTo(1.5, 6);
    expect(a.stages.decodeWait.p50).toBeCloseTo(0.3, 6);
    expect(a.stages.pageToWorklet.p50).toBeCloseTo(1, 6);
    expect(a.stages.buffer.p50).toBeCloseTo(40, 6);
    // 10 + 2 + 0.5 + 0.1 + 1.5 + 0.3 + 0.2 + 1 + 40 (sendCall overlaps transport)
    expect(a.pipeline.p50).toBeCloseTo(55.6, 6);
    expect(a.clockUncertaintyMs).toBe(3);
    expect(a.outages.count).toBe(0);
  });

  it('counts silence between played blocks as an outage with its recovery time', () => {
    const { host, listener } = synth(3000, 2000, 50);
    const a = analyse(host, listener);
    expect(a.outages.count).toBe(1);
    expect(a.outages.recoveryMs.max).toBeCloseTo(50, 6);
  });
});
