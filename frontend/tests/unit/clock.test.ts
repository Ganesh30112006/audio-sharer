import { describe, expect, it, vi } from 'vitest';
import { estimateOffset, ServerClock } from '../../src/utils/clock';

describe('estimateOffset', () => {
  it('picks the lowest round-trip sample', () => {
    const est = estimateOffset([
      { t0: 0, server: 10_050, t1: 100 }, // rtt 100
      { t0: 200, server: 10_215, t1: 220 }, // rtt 20 -> offset 10_215 - 210 = 10_005
      { t0: 300, server: 10_400, t1: 360 },
    ]);
    expect(est?.rtt).toBe(20);
    expect(est?.offset).toBe(10_005);
    expect(est?.uncertainty).toBe(10);
  });

  it('ignores invalid samples', () => {
    expect(estimateOffset([])).toBeUndefined();
    expect(estimateOffset([{ t0: 10, server: NaN, t1: 20 }])).toBeUndefined();
    expect(estimateOffset([{ t0: 30, server: 1, t1: 20 }])).toBeUndefined();
  });
});

describe('ServerClock', () => {
  it('maps the monotonic clock onto server time', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const clock = new ServerClock(async () => {
      now += 5;
      const server = 50_000 + now;
      now += 5;
      return server;
    });
    await clock.sync(3);
    now = 2000;
    expect(clock.now()).toBeCloseTo(52_000, 5);
  });

  it('falls back to wall clock when every sample fails', async () => {
    const clock = new ServerClock(() => Promise.reject(new Error('offline')));
    expect(await clock.sync(2)).toBeUndefined();
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
  });
});
