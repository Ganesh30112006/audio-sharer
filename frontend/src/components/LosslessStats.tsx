import { Lock } from 'lucide-react';
import type { LosslessReceiverStats } from '../audio/lossless/LosslessReceiver';
import type { LosslessSenderStats } from '../audio/lossless/LosslessSender';
import { useStoreState } from '../hooks/useStore';
import { formatPcmLabel as formatLabel } from '../utils/format';
import type { Store } from '../utils/store';

/** Live stats for the lossless transport (updates ~1–2×/s, only this panel re-renders). */
export function LosslessStats(
  props: { sender: Store<LosslessSenderStats> } | { receiver: Store<LosslessReceiverStats> },
) {
  const isSender = 'sender' in props;
  const s = useStoreState<LosslessSenderStats | LosslessReceiverStats>(
    isSender ? props.sender : props.receiver,
  );
  if (!s.active) return null;
  const rows: Array<[string, string]> = [
    ['Format', formatLabel(s)],
    ['Lossless data rate', `${s.kbps} kbps`],
  ];
  if (isSender) {
    const t = s as LosslessSenderStats;
    rows.push(
      ['Compression', `${Math.round(t.ratio * 100)}% of raw PCM`],
      ['Send queue', String(t.inFlight)],
    );
  } else {
    const r = s as LosslessReceiverStats;
    rows.push(
      ['Buffer', `${r.bufferMs.toFixed(0)} ms`],
      ['Underruns', String(r.underruns)],
      ['Clock corrections', String(r.clockCorrections)],
      ['Resyncs', String(r.resyncs)],
      ['Sequence gaps', String(r.gaps)],
    );
  }
  const congested = isSender && (s as LosslessSenderStats).congested;
  return (
    <section className="card" aria-labelledby="lossless-heading">
      <div className="card-header">
        <h2 id="lossless-heading">
          <Lock size={18} aria-hidden /> Lossless stream
        </h2>
        <span className={`pill ${congested ? 'pill-warning' : 'pill-success'}`}>
          {congested ? 'Network too slow' : 'Bit-exact'}
        </span>
      </div>
      {congested && (
        <p className="small" role="alert">
          Data is queuing faster than the network delivers it. Listeners will fall behind — switch
          to Studio (Opus) or use a faster connection.
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
