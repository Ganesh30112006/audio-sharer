import { useRef } from 'react';
import { useThrottledFrame } from '../hooks/useThrottledFrame';
import { formatTime } from '../utils/format';
import './ProgressBar.css';

interface ProgressBarProps {
  /** Reads the current position; called at most ~4×/s while active. */
  getTime: () => number;
  duration: number | null;
  active: boolean;
  onSeek?: (seconds: number) => void;
  label?: string;
}

/**
 * Media progress written directly to the DOM via refs: playback time never
 * passes through React state, so a playing track causes zero re-renders.
 */
export function ProgressBar({
  getTime,
  duration,
  active,
  onSeek,
  label = 'Playback position',
}: ProgressBarProps) {
  const rangeRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const seekable = !!onSeek && duration !== null && duration > 0;

  useThrottledFrame(() => {
    if (dragging.current) return;
    const t = getTime();
    if (rangeRef.current) rangeRef.current.value = String(duration ? Math.min(t, duration) : 0);
    if (timeRef.current) timeRef.current.textContent = formatTime(t);
    if (rangeRef.current && duration) {
      rangeRef.current.style.setProperty('--progress', `${Math.min(100, (t / duration) * 100)}%`);
      rangeRef.current.setAttribute(
        'aria-valuetext',
        `${formatTime(t)} of ${formatTime(duration)}`,
      );
    }
  }, active);

  return (
    <div className="progress">
      <span ref={timeRef} className="progress-time mono">
        0:00
      </span>
      <input
        ref={rangeRef}
        type="range"
        className="progress-range"
        min={0}
        max={duration ?? 0}
        step={0.1}
        defaultValue={0}
        disabled={!seekable}
        aria-label={label}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onBlur={() => (dragging.current = false)}
        onChange={(e) => {
          const t = Number(e.currentTarget.value);
          if (timeRef.current) timeRef.current.textContent = formatTime(t);
          onSeek?.(t);
        }}
      />
      <span className="progress-time mono">
        {duration !== null ? formatTime(duration) : 'Live'}
      </span>
    </div>
  );
}
