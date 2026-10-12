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

afterEach(() => {
  g.AudioContext = realAudioContext;
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
});
