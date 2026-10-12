import type { ReactNode } from 'react';
import { AlertTriangle, Info, XCircle, X } from 'lucide-react';

interface NoticeProps {
  tone?: 'info' | 'warning' | 'error';
  children: ReactNode;
  onDismiss?: () => void;
}

const icons = { info: Info, warning: AlertTriangle, error: XCircle };

export function Notice({ tone = 'info', children, onDismiss }: NoticeProps) {
  const Icon = icons[tone];
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden />
      <div className="notice-body">{children}</div>
      {onDismiss && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
