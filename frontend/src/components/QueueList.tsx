import { ListMusic, Trash2 } from 'lucide-react';
import type { QueueItem } from '../media/fileSource';
import { formatBytes } from '../utils/format';
import './QueueList.css';

interface QueueListProps {
  items: QueueItem[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

export function QueueList({ items, currentId, onSelect, onRemove }: QueueListProps) {
  return (
    <section className="card" aria-labelledby="queue-heading">
      <div className="card-header">
        <h2 id="queue-heading">
          <ListMusic size={18} aria-hidden /> Queue
        </h2>
        <span className="pill">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="empty">Add audio files to build a queue.</p>
      ) : (
        <ol className="queue">
          {items.map((item) => (
            <li key={item.id} className={item.id === currentId ? 'current' : undefined}>
              <button
                type="button"
                className="queue-item"
                onClick={() => onSelect(item.id)}
                aria-current={item.id === currentId ? 'true' : undefined}
              >
                <span className="queue-title">{item.title}</span>
                <span className="small muted">{formatBytes(item.size)}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => onRemove(item.id)}
                aria-label={`Remove ${item.title}`}
              >
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
