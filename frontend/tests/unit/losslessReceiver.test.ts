import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBlock } from '../../src/audio/lossless/codec';
import { LosslessReceiver } from '../../src/audio/lossless/LosslessReceiver';

function block(seq: number) {
  return encodeBlock({
    seq,
    sampleRate: 48_000,
    channels: 2,
    bitDepth: 16,
    samples: new Int32Array(480 * 2).fill(seq % 100),
    firstFrame: seq * 480,
  });
}

const g = globalThis as unknown as Record<string, unknown>;
const realAudioContext = g.AudioContext;
const realAudioWorkletNode = g.AudioWorkletNode;

afterEach(() => {
  g.AudioContext = realAudioContext;
  g.AudioWorkletNode = realAudioWorkletNode;
  vi.useRealTimers();
});

describe('LosslessReceiver playback graph', () => {
  it('does not retry a failed graph build in a tight loop, and releases the failed context', async () => {
    let created = 0;
    let closed = 0;
    g.AudioContext = class {
      sampleRate = 48_000;
      audioWorklet = { addModule: () => Promise.reject(new Error('module failed to load')) };
      constructor() {
        created++;
      }
      close() {
        closed++;
        return Promise.resolve();
      }
    };
    const r = new LosslessReceiver(() => Date.now());
    for (let seq = 0; seq < 5; seq++) r.push(block(seq));
    await new Promise((res) => setTimeout(res, 50));
    expect(created).toBe(1);
    expect(closed).toBe(1);
    expect(r.stats.get().error).toMatch(/module failed to load/);
    r.dispose();
  });

  it('accounts per playback graph and tells the player when a rebuild fails', async () => {
    let failNext = false;
    const nodes: Array<{ posted: unknown[] }> = [];
    g.AudioWorkletNode = class {
      posted: unknown[] = [];
      port = {
        postMessage: (m: unknown) => this.posted.push(m),
        onmessage: null,
        close() {},
      };
      constructor() {
        nodes.push(this);
      }
      connect() {}
      disconnect() {}
    };
    g.AudioContext = class {
      sampleRate: number;
      constructor(o: { sampleRate: number }) {
        this.sampleRate = o.sampleRate;
      }
      audioWorklet = {
        addModule: () =>
          failNext ? Promise.reject(new Error('module failed to load')) : Promise.resolve(),
      };
      createMediaStreamDestination() {
        return { stream: { getTracks: () => [] } };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    };
    const streams: unknown[] = [];
    const r = new LosslessReceiver(() => Date.now());
    r.events.on('stream', (s) => streams.push(s));
    const at = (seq: number, sampleRate: number) =>
      encodeBlock({
        seq,
        sampleRate,
        channels: 2,
        bitDepth: 16,
        samples: new Int32Array(480 * 2).fill(1),
        firstFrame: seq * 480,
      });
    const settle = () => new Promise((res) => setTimeout(res, 20));
    for (let seq = 0; seq < 3; seq++) r.push(at(seq, 48_000));
    await settle();
    // Format change: a new playback graph with its own counters.
    for (let seq = 3; seq < 5; seq++) r.push(at(seq, 44_100));
    await settle();
    (r as unknown as { publish(): void }).publish();
    expect(r.stats.get().deliveredFrames).toBe(960);
    expect(r.stats.get().decodedFrames).toBe(960);
    expect(nodes).toHaveLength(2);
    // Another format change whose graph fails to build: the player must drop
    // the old (stopped) stream rather than keep playing a dead one.
    failNext = true;
    r.push(at(5, 96_000));
    await settle();
    expect(streams[streams.length - 1]).toBeNull();
    expect(r.stats.get().error).toMatch(/module failed to load/);
    r.dispose();
  });
});
