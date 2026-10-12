import { describe, expect, it } from 'vitest';
import { ContextClockMap, TraceTable } from '../../src/audio/lossless/latencyTrace';

describe('TraceTable', () => {
  it('addresses rows by sequence number and reuses slots without leaking old values', () => {
    const t = new TraceTable(['a', 'b'] as const, 4);
    t.set(1, 'a', 10);
    t.set(1, 'b', 11);
    t.set(5, 'a', 50); // same slot as seq 1: the row starts fresh
    expect(t.get(1, 'a')).toBeNaN();
    expect(t.get(5, 'a')).toBe(50);
    expect(t.get(5, 'b')).toBeNaN();
    const d = t.dump();
    expect(d.seq).toEqual([5]);
    expect(d.rows[0]![0]).toBe(50);
  });

  it('keeps the first observation with setOnce', () => {
    const t = new TraceTable(['x'] as const);
    t.setOnce(7, 'x', 1);
    t.setOnce(7, 'x', 2);
    expect(t.get(7, 'x')).toBe(1);
  });
});

describe('ContextClockMap', () => {
  it('estimates the render-clock offset from the lower envelope of page-thread samples', () => {
    const m = new ContextClockMap();
    expect(m.offset).toBeNaN();
    const ctx = { currentTime: 0 } as BaseAudioContext;
    // Render clock = page clock - 100 ms; page-thread reads lag by 0..8 ms.
    const lags = [5, 0.5, 8, 3, 1];
    lags.forEach((lag, i) => {
      const now = 1000 + i * 10;
      (ctx as { currentTime: number }).currentTime = (now - 100 - lag) / 1000;
      m.sample(ctx, now);
    });
    expect(m.offset).toBeCloseTo(100.5, 6);
  });

  it('forgets samples older than two buckets (tracks drift)', () => {
    const m = new ContextClockMap();
    const ctx = { currentTime: 0 } as { currentTime: number };
    ctx.currentTime = 0;
    m.sample(ctx as BaseAudioContext, 0); // offset 0
    ctx.currentTime = 2.5 - 0.01;
    m.sample(ctx as BaseAudioContext, 2500); // offset 10, new bucket
    ctx.currentTime = 5 - 0.01;
    m.sample(ctx as BaseAudioContext, 5000); // offset 10, first bucket dropped
    expect(m.offset).toBeCloseTo(10, 6);
  });
});
