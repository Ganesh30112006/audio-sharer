import { Activity } from 'lucide-react';
import { useConnectionStats } from '../hooks/useConnectionStats';
import { useStore } from '../hooks/useStore';
import type { RoomConnection, RoomConnectionState } from '../services/roomConnection';
import { formatMs, formatPct } from '../utils/format';
import './DiagnosticsPanel.css';

interface DiagnosticsPanelProps {
  conn: RoomConnection;
  direction: 'inbound' | 'outbound';
  /** Additional locally known output latency (seconds), if any. */
  outputLatency?: number;
  clockUncertaintyMs?: number;
  /** Lossless mode has no Opus track: show connection-level rows only. */
  connectionOnly?: boolean;
}

const selReconnects = (s: RoomConnectionState) => s.reconnects;
const selRecovery = (s: RoomConnectionState) => s.lastRecoveryMs;
const selQuality = (s: RoomConnectionState) => s.quality;

export function DiagnosticsPanel({
  conn,
  direction,
  outputLatency,
  clockUncertaintyMs,
  connectionOnly = false,
}: DiagnosticsPanelProps) {
  const stats = useConnectionStats(conn, direction, !connectionOnly);
  const reconnects = useStore(conn.store, selReconnects);
  const recovery = useStore(conn.store, selRecovery);
  const quality = useStore(conn.store, selQuality);

  // Listener-side estimate: SFU->listener one-way (~RTT/2) + jitter buffer + known output latency.
  // Excludes the host's uplink and Bluetooth/OS buffering the browser can't see.
  const estimate =
    direction === 'inbound' && stats?.rttMs !== undefined
      ? stats.rttMs / 2 + (stats.jitterBufferMs ?? 0) + (outputLatency ?? 0) * 1000
      : undefined;

  const media: Array<[string, string, string?]> = [
    ['Codec', stats?.codec ?? '—'],
    ['Bitrate', stats?.bitrateKbps !== undefined ? `${stats.bitrateKbps.toFixed(0)} kbps` : '—'],
    ['Packet loss', formatPct(stats?.packetLossPct)],
    ['Jitter', formatMs(stats?.jitterMs, 1)],
    ['Round trip', formatMs(stats?.rttMs)],
  ];
  const rows: Array<[string, string, string?]> = [['Network quality', quality]];
  if (connectionOnly) {
    // Lossless stream metrics live in the Lossless stream panel.
  } else if (direction === 'inbound') {
    rows.push(
      ...media,
      ['Audio level', stats?.audioLevel !== undefined ? stats.audioLevel.toFixed(3) : '—'],
      ['Jitter buffer', formatMs(stats?.jitterBufferMs)],
      [
        'Concealed audio',
        formatPct(stats?.concealmentPct),
        'Share of audio the decoder had to fill in (audible glitches)',
      ],
      [
        'Concealment events',
        stats?.concealmentEvents !== undefined ? String(stats.concealmentEvents) : '—',
      ],
      [
        'Est. playback delay',
        formatMs(estimate),
        'Excludes host upload and Bluetooth/OS output buffering',
      ],
    );
  } else {
    rows.push(...media);
    if (outputLatency !== undefined)
      rows.push(['Monitor output latency', formatMs(outputLatency * 1000)]);
  }
  rows.push(['Reconnects', String(reconnects)], ['Last recovery', formatMs(recovery ?? undefined)]);
  if (clockUncertaintyMs !== undefined)
    rows.push(['Clock sync ±', formatMs(clockUncertaintyMs, 1)]);

  return (
    <section className="card" aria-labelledby="diag-heading">
      <div className="card-header">
        <h2 id="diag-heading">
          <Activity size={18} aria-hidden /> Diagnostics
        </h2>
        <span className="small muted">updates every 2 s</span>
      </div>
      <dl className="diag">
        {rows.map(([k, v, hint]) => (
          <div key={k} title={hint} data-metric={k}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
