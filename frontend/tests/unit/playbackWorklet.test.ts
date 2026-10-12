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
  const push = (frames: number) => {
    const pcm = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      value = (value + 1) % 1000;
      pcm[i * 2] = pcm[i * 2 + 1] = value / 1000;
    }
    pushed += frames;
    p.port.onmessage!({ data: { type: 'pcm', pcm } });
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
