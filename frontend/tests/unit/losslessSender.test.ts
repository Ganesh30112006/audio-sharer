import { afterEach, describe, expect, it } from 'vitest';
import { LosslessSender } from '../../src/audio/lossless/LosslessSender';

const g = globalThis as unknown as Record<string, unknown>;
const realNode = g.AudioWorkletNode;
afterEach(() => {
  g.AudioWorkletNode = realNode;
});

describe('LosslessSender capture worklet loading', () => {
  it('retries loading the capture worklet after a failed attempt on the same context', async () => {
    g.AudioWorkletNode = class {
      port = { onmessage: null, postMessage() {}, close() {} };
      connect(n: unknown) {
        return n;
      }
      disconnect() {}
    };
    let attempts = 0;
    const gain = { gain: { value: 1 }, connect: (n: unknown) => n, disconnect() {} };
    const ctx = {
      audioWorklet: {
        addModule: () => {
          attempts++;
          return attempts === 1 ? Promise.reject(new Error('chunk 404')) : Promise.resolve();
        },
      },
      createGain: () => gain,
      destination: {},
    } as unknown as AudioContext;
    const createNode = (
      LosslessSender as unknown as {
        createNode(c: AudioContext, f: (d: unknown) => void): Promise<unknown>;
      }
    ).createNode.bind(LosslessSender);
    await expect(createNode(ctx, () => undefined)).rejects.toThrow(/chunk 404/);
    // A transient failure must not disable lossless on this context for good.
    await expect(createNode(ctx, () => undefined)).resolves.toBeTruthy();
    expect(attempts).toBe(2);
  });
});
