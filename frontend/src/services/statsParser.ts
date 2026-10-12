/**
 * Turns WebRTC getStats() reports into a compact diagnostics snapshot.
 * Rates are computed from deltas between consecutive samples.
 */
export interface StatsSnapshot {
  timestamp: number;
  codec?: string;
  bitrateKbps?: number;
  packetLossPct?: number;
  jitterMs?: number;
  rttMs?: number;
  /** Average jitter-buffer delay over the last interval (receiver). */
  jitterBufferMs?: number;
  /** Share of samples concealed (audible glitches) over the last interval (receiver). */
  concealmentPct?: number;
  /** Cumulative count of concealment events (receiver). */
  concealmentEvents?: number;
  packetsLostTotal?: number;
  /** Received audio level 0..1 (receiver) — confirms sound, not just packets, arrives. */
  audioLevel?: number;
}

interface Counters {
  timestamp: number;
  bytes: number;
  packets: number;
  lost: number;
  jbDelay: number;
  jbEmitted: number;
  concealed: number;
  samples: number;
}

type Stat = Record<string, unknown> & { type: string; id: string };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function find(report: Map<string, Stat>, pred: (s: Stat) => boolean): Stat | undefined {
  for (const s of report.values()) if (pred(s)) return s;
  return undefined;
}

function toMap(report: RTCStatsReport | Map<string, Stat>): Map<string, Stat> {
  const m = new Map<string, Stat>();
  report.forEach((v: unknown, k: string) => m.set(k, v as Stat));
  return m;
}

function selectedPairRtt(m: Map<string, Stat>): number | undefined {
  const transport = find(m, (s) => s.type === 'transport');
  const pairId = transport?.selectedCandidatePairId as string | undefined;
  const pair =
    (pairId ? m.get(pairId) : undefined) ??
    find(
      m,
      (s) =>
        s.type === 'candidate-pair' &&
        (s.nominated === true || s.selected === true) &&
        s.state === 'succeeded',
    );
  const rtt = num(pair?.currentRoundTripTime);
  return rtt !== undefined ? rtt * 1000 : undefined;
}

export class StatsParser {
  private prev: Counters | undefined;

  constructor(private readonly direction: 'inbound' | 'outbound') {}

  parse(report: RTCStatsReport | Map<string, Stat>): StatsSnapshot {
    const m = toMap(report);
    return this.direction === 'inbound' ? this.inbound(m) : this.outbound(m);
  }

  reset(): void {
    this.prev = undefined;
  }

  private codecName(m: Map<string, Stat>, rtp: Stat | undefined): string | undefined {
    const codec = rtp?.codecId ? m.get(rtp.codecId as string) : undefined;
    const mime = codec?.mimeType as string | undefined;
    if (!mime) return undefined;
    const ch = num(codec?.channels);
    return `${mime.replace('audio/', '')}${ch === 2 ? ' stereo' : ''}`;
  }

  private inbound(m: Map<string, Stat>): StatsSnapshot {
    const rtp = find(m, (s) => s.type === 'inbound-rtp' && s.kind === 'audio');
    const timestamp = num(rtp?.timestamp) ?? performance.now();
    const cur: Counters = {
      timestamp,
      bytes: num(rtp?.bytesReceived) ?? 0,
      packets: num(rtp?.packetsReceived) ?? 0,
      lost: num(rtp?.packetsLost) ?? 0,
      jbDelay: num(rtp?.jitterBufferDelay) ?? 0,
      jbEmitted: num(rtp?.jitterBufferEmittedCount) ?? 0,
      concealed: num(rtp?.concealedSamples) ?? 0,
      samples: num(rtp?.totalSamplesReceived) ?? 0,
    };
    const snap: StatsSnapshot = {
      timestamp,
      codec: this.codecName(m, rtp),
      jitterMs: num(rtp?.jitter) !== undefined ? (rtp!.jitter as number) * 1000 : undefined,
      rttMs: selectedPairRtt(m),
      concealmentEvents: num(rtp?.concealmentEvents),
      packetsLostTotal: cur.lost,
      audioLevel: num(rtp?.audioLevel),
    };
    const p = this.prev;
    if (p && cur.timestamp > p.timestamp) {
      const dt = (cur.timestamp - p.timestamp) / 1000;
      snap.bitrateKbps = ((cur.bytes - p.bytes) * 8) / dt / 1000;
      const lost = cur.lost - p.lost;
      const total = cur.packets - p.packets + lost;
      snap.packetLossPct = total > 0 ? Math.max(0, lost / total) : 0;
      const emitted = cur.jbEmitted - p.jbEmitted;
      if (emitted > 0) snap.jitterBufferMs = ((cur.jbDelay - p.jbDelay) / emitted) * 1000;
      const samples = cur.samples - p.samples;
      if (samples > 0) snap.concealmentPct = Math.max(0, (cur.concealed - p.concealed) / samples);
    }
    this.prev = cur;
    return snap;
  }

  private outbound(m: Map<string, Stat>): StatsSnapshot {
    const rtp = find(m, (s) => s.type === 'outbound-rtp' && s.kind === 'audio');
    const remote = find(m, (s) => s.type === 'remote-inbound-rtp' && s.kind === 'audio');
    const timestamp = num(rtp?.timestamp) ?? performance.now();
    const bytes = num(rtp?.bytesSent) ?? 0;
    const remoteRtt = num(remote?.roundTripTime);
    const snap: StatsSnapshot = {
      timestamp,
      codec: this.codecName(m, rtp),
      rttMs: remoteRtt !== undefined ? remoteRtt * 1000 : selectedPairRtt(m),
      jitterMs: num(remote?.jitter) !== undefined ? (remote!.jitter as number) * 1000 : undefined,
      packetLossPct: num(remote?.fractionLost),
      packetsLostTotal: num(remote?.packetsLost),
    };
    const p = this.prev;
    if (p && timestamp > p.timestamp) {
      snap.bitrateKbps = ((bytes - p.bytes) * 8) / ((timestamp - p.timestamp) / 1000) / 1000;
    }
    this.prev = {
      timestamp,
      bytes,
      packets: 0,
      lost: 0,
      jbDelay: 0,
      jbEmitted: 0,
      concealed: 0,
      samples: 0,
    };
    return snap;
  }
}
