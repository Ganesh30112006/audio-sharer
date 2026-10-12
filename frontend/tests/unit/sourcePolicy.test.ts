import { describe, expect, it } from 'vitest';
import { estimateEgressKbps, policyFor } from '../../src/audio/sourcePolicy';

describe('policyFor', () => {
  it('never applies voice processing or DTX to music sources', () => {
    for (const kind of ['file', 'capture'] as const) {
      const p = policyFor(kind, 'high');
      expect(p.constraints.echoCancellation).toBe(false);
      expect(p.constraints.noiseSuppression).toBe(false);
      expect(p.constraints.autoGainControl).toBe(false);
      expect(p.publish.dtx).toBe(false);
      expect(p.publish.forceStereo).toBe(true);
      expect(p.publish.maxBitrate).toBe(128_000);
      expect(p.publish.red).toBe(true);
      expect(policyFor(kind, 'high', { lossProtection: false }).publish.red).toBe(false);
    }
    expect(policyFor('file', 'standard').publish.maxBitrate).toBe(64_000);
  });

  it('uses speech processing for microphones unless disabled', () => {
    const voice = policyFor('microphone', 'high');
    expect(voice.constraints.echoCancellation).toBe(true);
    expect(voice.publish.dtx).toBe(true);
    expect(voice.publish.red).toBe(true);
    expect(voice.trackSource).toBe('microphone');
    const raw = policyFor('microphone', 'high', { voiceProcessing: false });
    expect(raw.constraints.echoCancellation).toBe(false);
    expect(raw.publish.dtx).toBe(false);
  });
});

describe('estimateEgressKbps', () => {
  it('scales linearly with listeners', () => {
    const one = estimateEgressKbps(128_000, 1);
    expect(one).toBeGreaterThan(128);
    expect(one).toBeLessThan(160);
    expect(estimateEgressKbps(128_000, 100)).toBeCloseTo(one * 100);
    expect(estimateEgressKbps(32_000, 1, true)).toBeGreaterThan(
      estimateEgressKbps(32_000, 1, false),
    );
  });
});
