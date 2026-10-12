import { Users } from 'lucide-react';
import type { ParticipantSummary } from '../types/room';
import './ListenerList.css';

const QUALITY_LABEL: Record<string, string> = {
  excellent: 'Excellent connection',
  good: 'Good connection',
  poor: 'Poor connection',
  lost: 'Connection lost',
  unknown: 'Unknown connection quality',
};

const MAX_RENDERED = 200;

export function ListenerList({ participants }: { participants: ParticipantSummary[] }) {
  const listeners = participants.filter((p) => p.role === 'listener');
  const shown = listeners.slice(0, MAX_RENDERED);
  return (
    <section className="card" aria-labelledby="listeners-heading">
      <div className="card-header">
        <h2 id="listeners-heading">
          <Users size={18} aria-hidden /> Listeners
        </h2>
        <span className="pill pill-accent" aria-label={`${listeners.length} listeners`}>
          {listeners.length}
        </span>
      </div>
      {listeners.length === 0 ? (
        <p className="empty">No one has joined yet. Share the room code.</p>
      ) : (
        <ul className="listeners">
          {shown.map((p) => (
            <li key={p.identity}>
              <span
                className={`quality-dot q-${p.quality}`}
                title={QUALITY_LABEL[p.quality]}
                aria-hidden
              />
              <span className="listener-name">{p.name}</span>
              <span className="visually-hidden">{QUALITY_LABEL[p.quality]}</span>
            </li>
          ))}
          {listeners.length > shown.length && (
            <li className="muted small">and {listeners.length - shown.length} more</li>
          )}
        </ul>
      )}
    </section>
  );
}
