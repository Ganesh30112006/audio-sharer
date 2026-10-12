import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBlock } from '../../src/audio/lossless/codec';
import { CodecClient } from '../../src/audio/lossless/codecClient';
import type { CodecReply } from '../../src/audio/lossless/codecWorker';

const g = globalThis as unknown as Record<string, unknown>;
const realWorker = g.Worker;
afterEach(() => {
  g.Worker = realWorker;
});

class CrashingWorker {
  static last: CrashingWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  received = 0;
  constructor() {
    CrashingWorker.last = this;
  }
  postMessage() {
    this.received++;
  }
  terminate() {}
}

const payload = () =>
  encodeBlock({
    seq: 1,
    sampleRate: 48_000,
    channels: 2,
    bitDepth: 16,
    samples: new Int32Array(64 * 2).fill(7),
  });

describe('CodecClient', () => {
  it('answers every request even if the worker dies, then keeps working in-thread', async () => {
    g.Worker = CrashingWorker;
    const replies: CodecReply[] = [];
    const client = new CodecClient((r) => replies.push(r));
    expect(client.offMainThread).toBe(true);
    client.post({ op: 'decode', gen: 1, seq: 10, payload: payload() });
    client.post({ op: 'decode', gen: 1, seq: 11, payload: payload() });
    expect(CrashingWorker.last!.received).toBe(2);
    // The worker crashes (script failed to load, out of memory, ...).
    CrashingWorker.last!.onerror?.(new Event('error'));
    // Requests it never answered are failed explicitly, in order.
    expect(replies.map((r) => [r.op, r.seq])).toEqual([
      ['error', 10],
      ['error', 11],
    ]);
    // Later requests run in-thread and succeed.
    client.post({ op: 'decode', gen: 1, seq: 12, payload: payload() });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[2]).toMatchObject({ op: 'decoded', seq: 12 });
    expect(client.offMainThread).toBe(false);
  });
});
