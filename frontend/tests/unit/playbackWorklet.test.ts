import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real playback worklet module under simulated AudioWorklet globals
 * (sampleRate, currentTime, AudioWorkletProcessor, registerProcessor), so the
 * jitter buffer's accounting can be tested without a browser.
 */
const RATE = 48_000;
const QUANTUM = 128;

interface Port {
  posted: Array<Record<string, unknown>>;
  postMessage(msg: Record<string, unknown>): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}
interface Processor {
  port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorClass = new (options: { processorOptions: Record<string, unknown> }) => Processor;

const g = globalThis as unknown as Record<string, unknown>;
let Playback: ProcessorClass;

beforeAll(async () => {
  g.sampleRate = RATE;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port: Port = {
      posted: [],
      postMessage(msg) {
        this.posted.push(msg);
      },
      onmessage: null,
    };
  };
  g.registerProcessor = (_name: string, cls: ProcessorClass) => {
    Playback = cls;
  };
  // @ts-expect-error -- a worklet script: registers its processor, exports nothing
  await import('../../src/audio/lossless/playbackWorklet');
});

function create(opts: Record<string, unknown> = {}) {
  const p = new Playback({
    processorOptions: { channels: 2, targetMs: 40, maxMs: 1500, ...opts },
  });
  let pushed = 0;
  let value = 0;
  const push = (frames: number, extra: Record<string, unknown> = {}) => {
    const pcm = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      value = (value + 1) % 1000;
      pcm[i * 2] = pcm[i * 2 + 1] = value / 1000;
    }
    pushed += frames;
    p.port.onmessage!({ data: { type: 'pcm', pcm, ...extra } });
  };
  const outputs = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];
  const render = (quanta: number) => {
    for (let i = 0; i < quanta; i++) {
      p.process([], outputs);
      g.currentTime = (g.currentTime as number) + QUANTUM / RATE;
    }
  };
  const stats = () => {
    // Force a report on the next quantum.
    g.currentTime = (g.currentTime as number) + 1;
    p.process([], outputs);
    const all = p.port.posted.filter((m) => m.type === 'stats');
    return all[all.length - 1] as unknown as {
      playedFrames: number;
      skippedFrames: number;
      bufferedFrames: number;
      repeatedFrames: number;
      underruns: number;
      targetMs: number;
    };
  };
  return { p, push, render, stats, pushed: () => pushed };
}

describe('playback worklet accounting (decoded = played + skipped + buffered)', () => {
  it('holds in steady playback', () => {
    const w = create();
    for (let i = 0; i < 300; i++) {
      w.push(480);
      w.render(4); // ~10.7 ms per 10 ms block: the buffer slowly drains and re-buffers
    }
    const s = w.stats();
    expect(s.playedFrames + s.skippedFrames + s.bufferedFrames).toBe(w.pushed());
  });

  it('holds when more than the ring capacity arrives while rendering is stalled', () => {
    // A suspended AudioContext stops process() while messages keep arriving.
    const w = create();
    for (let i = 0; i < 500; i++) w.push(480); // 5 s > 4 s ring
    w.render(50);
    const s = w.stats();
    expect(s.playedFrames + s.skippedFrames + s.bufferedFrames).toBe(w.pushed());
  });

  it('holds across a discontinuity reset', () => {
    const w = create();
    for (let i = 0; i < 50; i++) w.push(480);
    w.render(20);
    w.p.port.onmessage!({ data: { type: 'reset' } });
    for (let i = 0; i < 50; i++) w.push(480);
    w.render(100);
    const s = w.stats();
    expect(s.playedFrames + s.skippedFrames + s.bufferedFrames).toBe(w.pushed());
  });
});

describe('playback worklet adaptive buffer after a source pause', () => {
  /** Streams 10 ms blocks in real time; `gapMs` of silence from the source mid-way. */
  function run(timingFlag: boolean, gapMs: number) {
    const w = create({ adaptive: true, minMs: 20 });
    let produced = 0; // frames due from the source so far (render clock)
    let sent = 0;
    let first = true;
    const step = (quanta: number, sending: boolean) => {
      for (let q = 0; q < quanta; q++) {
        produced += QUANTUM;
        while (sending && produced - sent >= 480) {
          w.push(480, first && timingFlag ? { timing: true } : {});
          first = false;
          sent += 480;
        }
        w.render(1);
      }
    };
    step(Math.round((3 * RATE) / QUANTUM), true); // 3 s streaming
    step(Math.round(((gapMs / 1000) * RATE) / QUANTUM), false); // source paused
    sent = produced; // the source resumes "now": its timeline continues seamlessly
    first = true;
    step(Math.round((4 * RATE) / QUANTUM), true); // 4 s streaming
    return w.stats();
  }

  it('without a timing reset, the pause is mistaken for jitter (documents the failure mode)', () => {
    expect(run(false, 2000).targetMs).toBeGreaterThan(300);
  });

  it('with the timing reset, the buffer stays at its normal size', () => {
    const s = run(true, 2000);
    expect(s.targetMs).toBeLessThan(80);
    expect(s.playedFrames + s.skippedFrames + s.bufferedFrames).toBeGreaterThan(0);
  });
});
