import { describe, expect, it } from 'vitest';
import { correctDrift, DEFAULT_DRIFT_POLICY } from '../../src/audio/driftCorrector';

describe('correctDrift', () => {
  it('ignores drift inside the deadband', () => {
    expect(correctDrift(0.01, 10, 1)).toEqual({ kind: 'none', rate: 1 });
    expect(correctDrift(-0.015, 10, 1)).toEqual({ kind: 'none', rate: 1 });
  });

  it('slows down when ahead and speeds up when behind', () => {
    const ahead = correctDrift(0.04, 10, 1);
    const behind = correctDrift(-0.04, 10, 1);
    expect(ahead.kind).toBe('rate');
    expect(ahead.rate).toBeLessThan(1);
    expect(behind.rate).toBeGreaterThan(1);
    expect(ahead.rate).toBeCloseTo(0.98);
  });

  it('caps the rate change', () => {
    const r = correctDrift(0.45, 10, 1);
    expect(r.kind).toBe('rate');
    expect(Math.abs(r.rate - 1)).toBeLessThanOrEqual(DEFAULT_DRIFT_POLICY.maxRateDelta + 1e-9);
  });

  it('respects a non-unity base rate', () => {
    expect(correctDrift(0, 10, 1.5).rate).toBe(1.5);
    expect(correctDrift(0.1, 10, 1.5).rate).toBeLessThan(1.5);
  });

  it('seeks on gross offsets', () => {
    expect(correctDrift(2, 12, 1)).toEqual({ kind: 'seek', position: 12, rate: 1 });
    expect(correctDrift(-0.8, -0.2, 1)).toEqual({ kind: 'seek', position: 0, rate: 1 });
  });

  it('does nothing for invalid input', () => {
    expect(correctDrift(NaN, 0, 1).kind).toBe('none');
  });
});
