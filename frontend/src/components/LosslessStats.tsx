import { AlertTriangle, Lock } from 'lucide-react';
import type { LosslessReceiverStats } from '../audio/lossless/LosslessReceiver';
import type { LosslessSenderStats } from '../audio/lossless/LosslessSender';
import { useStoreState } from '../hooks/useStore';
import { formatPcmLabel as formatLabel } from '../utils/format';
import type { Store } from '../utils/store';

const CAUSE: Record<string, string> = {
  'encoder-overload': 'this device could not encode fast enough',
  'network-congestion': 'the network could not carry the stream fast enough',
  'transport-error': 'the connection to the audio server failed',
  'decoder-overload': 'this device could not decode fast enough',
  'upstream-gap': 'audio was missing from the stream',
};

const sec = (frames: number, rate: number) => (rate ? (frames / rate).toFixed(2) : '0');

/**
 * Lossless transport status. Interruptions are shown explicitly: the stream
 * is either bit-exact or the user is told exactly when continuity broke.
 * Updates ~2×/s; only this panel re-renders.
 */
export function LosslessStats(
  props: { sender: Store<LosslessSenderStats> } | { receiver: Store<LosslessReceiverStats> },
) {
  const isSender = 'sender' in props;
  const s = useStoreState<LosslessSenderStats | LosslessReceiverStats>(
    isSender ? props.sender : props.receiver,
  );
  const failure = isSender ? null : (s as LosslessReceiverStats).error;
  if (!s.active)
    return failure ? (
      <section className="card" aria-label="Lossless stream">
        <p className="small row" role="alert" style={{ color: 'var(--warning)' }}>
          <AlertTriangle size={16} aria-hidden /> Lossless playback could not start: {failure}.
          Retrying automatically.
        </p>
      </section>
    ) : null;
  const rows: Array<[string, string]> = [
    ['Format', formatLabel(s)],
    ['Lossless data rate', `${s.kbps} kbps`],
  ];
  let banner: string | null = null;
  let interrupted: boolean;
  if (isSender) {
    const t = s as LosslessSenderStats;
    interrupted = t.state === 'interrupted';
    if (t.interruption)
      banner = `Stream interrupted: ${CAUSE[t.interruption.cause] ?? t.interruption.cause}.`;
    rows.push(
      ['Compression', `${Math.round(t.ratio * 100)}% of raw PCM`],
      ['Send queue', `${t.sendQueueBlocks} blocks / ${t.sendQueueKB} KB`],
      ['Oldest queued', `${t.oldestAgeMs} ms`],
      ['Interruptions', String(t.interruptions)],
      ['Audio not sent', `${sec(t.droppedFrames, t.sampleRate)} s`],
      [
        'Encoder load',
        `${Math.round(t.encoderUtilization * 100)}%${t.offMainThread ? ' (worker)' : ' (main thread)'}`,
      ],
    );
  } else {
    const r = s as LosslessReceiverStats;
    interrupted = r.outages > 0 && r.bufferMs === 0;
    if (r.unexpectedGaps > 0)
      banner = `${r.unexpectedGaps} unannounced gap(s) detected — continuity was broken.`;
    rows.push(
      ['Buffer', `${r.bufferMs} ms`],
      [
        'Buffer target',
        `${r.targetMs} ms (jitter ${r.jitterMs} ms, stall memory ${r.stallMemoryMs} ms)`,
      ],
      ['Outages', String(r.outages)],
      ['Last recovery', r.lastRecoveryMs === null ? '—' : `${r.lastRecoveryMs} ms`],
      ['Announced gaps', String(r.announcedGaps)],
      ['Unannounced gaps', String(r.unexpectedGaps)],
      ['Frames played', String(r.playedFrames)],
      ['Silence inserted', `${sec(r.silenceFrames, r.sampleRate)} s`],
      ['Clock corrections', String(r.clockCorrections)],
      ['Transit', r.transitMs === null ? '—' : `${r.transitMs} ms`],
      [
        'Decoder load',
        `${Math.round(r.decoderUtilization * 100)}%${r.offMainThread ? ' (worker)' : ' (main thread)'}`,
      ],
    );
  }
  return (
    <section className="card" aria-labelledby="lossless-heading">
      <div className="card-header">
        <h2 id="lossless-heading">
          <Lock size={18} aria-hidden /> Lossless stream
        </h2>
        <span
          className={`pill ${interrupted || banner ? 'pill-warning' : 'pill-success'}`}
          data-testid="lossless-state"
        >
          {interrupted ? 'Interrupted' : 'Bit-exact'}
        </span>
      </div>
      {banner && (
        <p
          className="small row"
          role="alert"
          style={{ color: 'var(--warning)', flexWrap: 'nowrap' }}
        >
          <AlertTriangle size={16} aria-hidden /> {banner} Audio resumes automatically; nothing is
          spliced across the gap.
        </p>
      )}
      <dl className="diag">
        {rows.map(([k, v]) => (
          <div key={k} data-metric={`lossless ${k}`}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
