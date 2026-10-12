import { describe, expect, it } from 'vitest';
import { RenderPauseDetector } from '../../src/audio/lossless/renderPause';

describe('RenderPauseDetector', () => {
  it('flags a suspended context (render clock stopped while wall time ran)', () => {
    const d = new RenderPauseDetector(1000);
    expect(d.check(0, 0)).toBe(false);
    expect(d.check(10, 10)).toBe(false);
    // Suspended for 5 s: wall advances, context time does not.
    expect(d.check(5010, 20)).toBe(true);
    expect(d.check(5020, 30)).toBe(false);
  });

  it('does not flag a page-thread stall (both clocks advanced)', () => {
    const d = new RenderPauseDetector(1000);
    d.check(0, 0);
    // The page thread was blocked for 2 s; the audio thread kept rendering.
    expect(d.check(2000, 1995)).toBe(false);
    // The blocks it produced meanwhile arrive in a burst.
    expect(d.check(2001, 1996)).toBe(false);
  });

  it('ignores short pauses and starts fresh after reset', () => {
    const d = new RenderPauseDetector(1000);
    d.check(0, 0);
    expect(d.check(900, 0)).toBe(false); // 0.9 s: below the threshold
    d.reset();
    expect(d.check(10_000, 0)).toBe(false); // first sample after reset
  });

  it('by default catches the 0.5 s jump a 2 s host pause leaves', () => {
    // The host sends silence for 1.5 s before its graph is suspended.
    const d = new RenderPauseDetector();
    d.check(0, 0);
    expect(d.check(510, 10)).toBe(true);
    // Normal block cadence with a page thread lagging one device callback: no.
    const e = new RenderPauseDetector();
    e.check(0, 0);
    expect(e.check(50, 10)).toBe(false);
  });
});
