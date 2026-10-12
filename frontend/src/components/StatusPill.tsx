import type { ConnectionState, Quality } from '../types/room';

const LABELS: Record<ConnectionState, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  failed: 'Connection failed',
};

const TONES: Record<ConnectionState, string> = {
  idle: '',
  connecting: 'pill-warning',
  connected: 'pill-success',
  reconnecting: 'pill-warning',
  disconnected: '',
  failed: 'pill-danger',
};

export function StatusPill({ state, quality }: { state: ConnectionState; quality?: Quality }) {
  const poor = state === 'connected' && (quality === 'poor' || quality === 'lost');
  return (
    <span
      className={`pill ${poor ? 'pill-warning' : TONES[state]}`}
      role="status"
      aria-live="polite"
    >
      <span className="pill-dot" aria-hidden />
      {LABELS[state]}
      {poor && ' · weak network'}
    </span>
  );
}
