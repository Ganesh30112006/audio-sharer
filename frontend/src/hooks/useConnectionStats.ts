import { useEffect, useState } from 'react';
import type { RoomConnection } from '../services/roomConnection';
import { StatsParser, type StatsSnapshot } from '../services/statsParser';

/**
 * Samples WebRTC stats only while the diagnostics view is mounted and the page
 * is visible. A 2 s cadence keeps getStats() overhead negligible.
 */
export function useConnectionStats(
  conn: RoomConnection | null,
  direction: 'inbound' | 'outbound',
  enabled: boolean,
  intervalMs = 2000,
): StatsSnapshot | null {
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);

  useEffect(() => {
    if (!conn || !enabled) return;
    const parser = new StatsParser(direction);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const sample = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const report = await conn.getStats();
          if (!cancelled) setSnapshot(report ? parser.parse(report) : null);
        } catch {
          // stats are best effort
        }
      }
      if (!cancelled) timer = setTimeout(sample, intervalMs);
    };
    void sample();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [conn, direction, enabled, intervalMs]);

  return enabled ? snapshot : null;
}
