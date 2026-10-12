import { describe, expect, it } from 'vitest';
import { StatsParser } from '../../src/services/statsParser';

type Stat = Record<string, unknown> & { type: string; id: string };
const report = (...stats: Stat[]) => new Map(stats.map((s) => [s.id, s]));

const codec: Stat = { id: 'c1', type: 'codec', mimeType: 'audio/opus', channels: 2 };
const transport: Stat = { id: 't', type: 'transport', selectedCandidatePairId: 'p' };
const pair: Stat = {
  id: 'p',
  type: 'candidate-pair',
  currentRoundTripTime: 0.04,
  state: 'succeeded',
};

function inbound(ts: number, n: Partial<Record<string, number>>): Stat {
  return {
    id: 'in',
    type: 'inbound-rtp',
    kind: 'audio',
    codecId: 'c1',
    timestamp: ts,
    jitter: 0.004,
    ...n,
  };
}

describe('StatsParser inbound', () => {
  it('computes interval rates from deltas', () => {
    const p = new StatsParser('inbound');
    const first = p.parse(
      report(
        codec,
        transport,
        pair,
        inbound(1000, {
          bytesReceived: 0,
          packetsReceived: 0,
          packetsLost: 0,
          jitterBufferDelay: 0,
          jitterBufferEmittedCount: 0,
          concealedSamples: 0,
          totalSamplesReceived: 0,
          concealmentEvents: 0,
        }),
      ),
    );
    expect(first.codec).toBe('opus stereo');
    expect(first.rttMs).toBeCloseTo(40);
    expect(first.jitterMs).toBeCloseTo(4);
    expect(first.bitrateKbps).toBeUndefined();

    const second = p.parse(
      report(
        codec,
        transport,
        pair,
        inbound(3000, {
          bytesReceived: 32_000, // 256 kbit over 2 s
          packetsReceived: 98,
          packetsLost: 2,
          jitterBufferDelay: 4800, // seconds, summed per emitted sample (50 ms each)
          jitterBufferEmittedCount: 96_000,
          concealedSamples: 960,
          totalSamplesReceived: 96_000,
          concealmentEvents: 3,
        }),
      ),
    );
    expect(second.bitrateKbps).toBeCloseTo(128);
    expect(second.packetLossPct).toBeCloseTo(0.02);
    expect(second.jitterBufferMs).toBeCloseTo(50);
    expect(second.concealmentPct).toBeCloseTo(0.01);
    expect(second.concealmentEvents).toBe(3);
  });

  it('tolerates empty reports', () => {
    const snap = new StatsParser('inbound').parse(new Map());
    expect(snap.codec).toBeUndefined();
    expect(snap.rttMs).toBeUndefined();
  });
});

describe('StatsParser outbound', () => {
  it('reads remote-inbound RTT and loss', () => {
    const p = new StatsParser('outbound');
    const out = (ts: number, bytes: number): Stat => ({
      id: 'o',
      type: 'outbound-rtp',
      kind: 'audio',
      codecId: 'c1',
      timestamp: ts,
      bytesSent: bytes,
    });
    const remote: Stat = {
      id: 'r',
      type: 'remote-inbound-rtp',
      kind: 'audio',
      roundTripTime: 0.03,
      fractionLost: 0.01,
      jitter: 0.002,
    };
    p.parse(report(codec, out(0, 0), remote));
    const snap = p.parse(report(codec, out(1000, 16_000), remote));
    expect(snap.rttMs).toBeCloseTo(30);
    expect(snap.packetLossPct).toBeCloseTo(0.01);
    expect(snap.bitrateKbps).toBeCloseTo(128);
  });
});
